/**
 * Tell billing-service when a brand's spendable budget may have changed on THIS side
 * (MON-PAGE-SPEED-2-1112).
 *
 * billing stores our `GET /brands/:brandId/spendable-budget` answer per (org, brand) so the
 * dashboard's runway never waits on us (0.5-1.5 s per read under load, 2026-11-12). It
 * catches its OWN budget writes itself; a change of ours (a campaign or funnel campaign
 * created, deleted, started, paused, stopped, moved) is pushed from here:
 *
 *  - the DATABASE notes every such change in `spendable_budget_changes` (triggers, migration
 *    0089), so no write path of this service can forget it;
 *  - this loop drains the table into billing's `POST /internal/spendable-budget-snapshots/
 *    invalidate`. A row is deleted only once billing acknowledged it, and only if no newer
 *    change landed meanwhile; a failed push keeps every row and is retried next tick
 *    (logged, never dropped). billing then never serves its stored answer for that brand
 *    and asks us once on its next read.
 *
 * A pair billing cannot hold (an org or brand id that is not a UUID: billing keys both on
 * uuid) has no stored answer there to invalidate: it is deleted with a log line.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { spendableBudgetChanges } from "../db/schema.js";

export const PUSH_INTERVAL_MS = 5_000;
export const FIRST_PUSH_DELAY_MS = 15_000;
export const PUSH_BATCH = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `changedAt` is read as Postgres TEXT, never a JS Date: a Date drops the microseconds, and a
// delete keyed on the truncated value would never match the row it read (pushed forever).
type Change = { orgId: string; brandId: string; changedAt: string };

async function forget(rows: Change[]): Promise<void> {
  for (const r of rows) {
    await db
      .delete(spendableBudgetChanges)
      .where(
        and(
          eq(spendableBudgetChanges.orgId, r.orgId),
          eq(spendableBudgetChanges.brandId, r.brandId),
          sql`${spendableBudgetChanges.changedAt} <= ${r.changedAt}::timestamptz`,
        ),
      );
  }
}

/**
 * One drain pass: push up to PUSH_BATCH noted changes to billing. Returns how many were
 * acknowledged. Throws when billing cannot be told (the rows stay for the next pass).
 */
export async function pushSpendableBudgetChanges(fetchImpl: typeof fetch = fetch): Promise<number> {
  const rows: Change[] = await db
    .select({
      orgId: spendableBudgetChanges.orgId,
      brandId: spendableBudgetChanges.brandId,
      changedAt: sql<string>`${spendableBudgetChanges.changedAt}::text`,
    })
    .from(spendableBudgetChanges)
    .orderBy(asc(spendableBudgetChanges.changedAt))
    .limit(PUSH_BATCH);
  if (rows.length === 0) return 0;

  const unheld = rows.filter((r) => !UUID_RE.test(r.orgId) || !ANY_UUID_RE.test(r.brandId));
  if (unheld.length > 0) {
    console.warn(
      `[campaign-service] spendable-budget push: ${unheld.length} change(s) on non-UUID ids billing cannot hold, dropped: ${unheld
        .slice(0, 5)
        .map((r) => `${r.orgId}/${r.brandId}`)
        .join(", ")}`,
    );
    await forget(unheld);
  }
  const pushable = rows.filter((r) => !unheld.includes(r));
  if (pushable.length === 0) return 0;

  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("BILLING_SERVICE_URL / BILLING_SERVICE_API_KEY not configured");
  const res = await fetchImpl(`${url.replace(/\/$/, "")}/internal/spendable-budget-snapshots/invalidate`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ brands: pushable.map((r) => ({ orgId: r.orgId, brandId: r.brandId })) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`billing invalidate answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  await forget(pushable);
  return pushable.length;
}

let running = false;
let started = false;

/** In-process drain loop, first pass FIRST_PUSH_DELAY_MS after boot. Never awaited by boot. */
export function startSpendableBudgetPush(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Drain a backlog in consecutive batches, then wait for the next tick.
      for (;;) {
        const n = await pushSpendableBudgetChanges();
        if (n < PUSH_BATCH) break;
      }
    } catch (err) {
      console.error("[campaign-service] spendable-budget push to billing failed (kept, retried next tick):", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), PUSH_INTERVAL_MS).unref?.();
  }, FIRST_PUSH_DELAY_MS).unref?.();
}
