import { and, eq, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, campaignStatusTransitions, type NewCampaignStatusTransition } from "../db/schema.js";

/** The transaction handle `db.transaction` hands its callback. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A campaign's STATUS is the customer's statement of intent, and every change to it leaves a
 * trace. This module is the ONLY place a status is written.
 *
 * The reason it is one place rather than a convention is what the trace is FOR: somebody reading
 * the company's run-rate for a past month needs to know, for any past day, whether each campaign
 * was actually earning — and paused is not MRR. A status change that lands without a transition
 * row is a day that can never be replayed, and it is invisible: nothing errors, no test goes red,
 * the campaign behaves perfectly, and the hole only surfaces months later as a run-rate nobody can
 * reproduce. So the update and its trace are written in ONE transaction: either both land or
 * neither does, and no call site can perform half of it.
 *
 * `tests/unit/no-legacy.test.ts` fails if a status is written to `campaigns` anywhere else.
 */

/** WHICH path wrote a transition. Every path that changes a status is named here. */
export const TRANSITION_SOURCES = {
  /** POST /campaigns inserted a new campaign — its birth. */
  CREATE: "create",
  /** POST /campaigns matched an existing campaign; the customer is (re)starting it. */
  CREATE_RESTART: "create_restart",
  /** PATCH /campaigns/:id with status=activate|stop — a person's decision. */
  PATCH: "patch",
  /** DELETE /internal/campaigns/by-org/:orgId — the org is gone. */
  ORG_TEARDOWN: "org_teardown",
  /** Migration 0057 opened the record by observing the PRESENT. Never written by the runtime. */
  RECORD_OPENED: "record_opened",
} as const;

export type TransitionSource = (typeof TRANSITION_SOURCES)[keyof typeof TRANSITION_SOURCES];

type StatusWrite = {
  campaignId: string;
  orgId: string;
  /** The status the row held before this write, as read by the caller. NULL for a birth. */
  fromStatus: string | null;
  toStatus: string;
  /** The stop reason that accompanies this transition (STOP_REASONS), or null. */
  reason: string | null;
  source: TransitionSource;
  /** Everything else the same write sets — nextRunAt, workflowSlug, the caller's own fields. */
  fields?: Record<string, unknown>;
};

/**
 * Change a campaign's status AND record the transition, atomically.
 *
 * Returns the updated row, or null when the id matched nothing (the caller decides what that
 * means; nothing is recorded for a campaign that was not there).
 */
export async function setCampaignStatus(write: StatusWrite) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(campaigns)
      .set({
        ...(write.fields ?? {}),
        status: write.toStatus,
        stopReason: write.reason,
        updatedAt: new Date(),
      })
      .where(and(eq(campaigns.id, write.campaignId), eq(campaigns.orgId, write.orgId)))
      .returning();

    if (!updated) return null;

    await tx.insert(campaignStatusTransitions).values({
      campaignId: write.campaignId,
      orgId: write.orgId,
      fromStatus: write.fromStatus,
      toStatus: write.toStatus,
      reason: write.reason,
      source: write.source,
    });

    return updated;
  });
}

/**
 * Stop every campaign an org holds, recording one transition each — inside a transaction the
 * caller already owns (the teardown does more than campaigns in the same atomic step).
 *
 * The rows are read BEFORE they are updated, so each transition states the status it actually
 * came from rather than leaving it unstated.
 */
export async function stopOrgCampaignsWithHistory(
  tx: DbTransaction,
  orgId: string,
  reason: string,
  predicate: SQL | undefined,
): Promise<{ id: string }[]> {
  const before = await tx
    .select({ id: campaigns.id, status: campaigns.status })
    .from(campaigns)
    .where(predicate);

  if (before.length === 0) return [];

  const updated = await tx
    .update(campaigns)
    .set({ status: "stopped", stopReason: reason, nextRunAt: null, updatedAt: new Date() })
    .where(predicate)
    .returning({ id: campaigns.id });

  const statusById = new Map(before.map((c) => [c.id, c.status]));
  await tx.insert(campaignStatusTransitions).values(
    updated.map((c) => ({
      campaignId: c.id,
      orgId,
      fromStatus: statusById.get(c.id) ?? null,
      toStatus: "stopped",
      reason,
      source: TRANSITION_SOURCES.ORG_TEARDOWN,
    })),
  );

  return updated;
}

/**
 * Record transitions inside a transaction the caller already owns — the campaign INSERT leg,
 * which writes the row and its birth together.
 */
export async function insertCampaignStatusTransitions(
  tx: DbTransaction,
  rows: NewCampaignStatusTransition[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(campaignStatusTransitions).values(rows);
}

/**
 * Record a campaign's BIRTH. Called inside the same transaction that inserts it.
 *
 * A birth is a transition like any other — `fromStatus` NULL — because a replay must be able to
 * tell "this campaign did not exist yet" from "it existed and was stopped", and from "we were not
 * recording yet". Three different answers, and only the first two are knowable from a row.
 */
export function campaignBirthTransition(
  campaignId: string,
  orgId: string,
  status: string,
): NewCampaignStatusTransition {
  return {
    campaignId,
    orgId,
    fromStatus: null,
    toStatus: status,
    reason: null,
    source: TRANSITION_SOURCES.CREATE,
  };
}
