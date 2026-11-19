import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { triggerEventDeliveries, triggerEvents } from "../db/schema.js";
import { siblingReadSignal } from "./sibling-read-timeout.js";

/**
 * ANSWERING A PERSON WHO WROTE TO US IS NEVER BLOCKED BY AN EMPTY BALANCE (REPLY-NO-BALANCE-1118).
 *
 * Owner 2026-11-18: « C'EST NON PROFESSIONNEL. ÇA COÛTE 3 CENTS DE RÉPONDRE ». Doc Dinners' prepaid balance hit $0 on
 * 2026-11-10 (auto top-up off, no card). For 8 days every Lead event run carrying a doctor who asked for prices or
 * cities was refused here ("Insufficient credits", 1,189 refusals on one campaign) and then given up.
 *
 * New outreach to new people stays blocked by an empty balance: the customer funds it. A reply is not new outreach.
 * When the credit check says the org cannot afford a run, the run is still admitted when it carries ONE person (the
 * occurrence it was dispatched for names a lead) and lead-service, the owner of that fact, says that person is waiting
 * on our answer at the brand (`GET /orgs/leads/awaiting-reply?leadId=`). Billing is told (`POST /internal/answer-passes`)
 * so the run's own spends (the LLM call, the send) authorize past the balance. Anything unreadable = the old refusal:
 * the occurrence stays owed and is retried, never a silent default-allow.
 */

export interface AnswerOwed {
  leadId: string;
  brandId: string;
}

export type AnswerOwedRead =
  | { owed: true; answer: AnswerOwed }
  | { owed: false; why: string };

/** The gate can reach us before the dispatch wrote the delivery row (prod: up to 2.6 s early). */
const DELIVERY_ROW_TRIES = 4;
const DELIVERY_ROW_WAIT_MS = 1_000;

async function personOfRun(runId: string, waitMs: number): Promise<{ leadId: string | null; brandId: string } | null> {
  for (let i = 0; i < DELIVERY_ROW_TRIES; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, waitMs));
    const [row] = await db
      .select({ leadId: triggerEvents.leadId, brandId: triggerEvents.brandId })
      .from(triggerEventDeliveries)
      .innerJoin(triggerEvents, eq(triggerEvents.id, triggerEventDeliveries.eventId))
      .where(eq(triggerEventDeliveries.runId, runId))
      .limit(1);
    if (row) return row;
  }
  return null;
}

async function waitingOnUs(orgId: string, brandId: string, leadId: string): Promise<{ ok: true; waiting: boolean } | { ok: false; detail: string }> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) return { ok: false, detail: "lead-service not configured" };
  try {
    const params = new URLSearchParams({ brandId, leadId });
    const res = await fetch(`${url}/orgs/leads/awaiting-reply?${params}`, {
      headers: { "x-api-key": apiKey, "x-org-id": orgId },
      signal: siblingReadSignal(),
    });
    if (!res.ok) return { ok: false, detail: `lead-service answered ${res.status}` };
    const body = (await res.json()) as { people?: Array<{ leadId?: string }> };
    if (!Array.isArray(body.people)) return { ok: false, detail: "lead-service answered without people" };
    return { ok: true, waiting: body.people.some((p) => p.leadId === leadId) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function grantPass(input: { orgId: string; campaignId: string; runId: string } & AnswerOwed): Promise<{ ok: true } | { ok: false; detail: string }> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) return { ok: false, detail: "billing not configured" };
  try {
    const res = await fetch(`${url}/internal/answer-passes`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: siblingReadSignal(),
    });
    if (res.status !== 201) return { ok: false, detail: `billing answered ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether this run answers a person waiting on us, and if so, billing holds the pass for its spends.
 * Only asked when the credit check refused the run.
 */
export async function admitAnswerOwed(
  input: { orgId: string; campaignId: string; runId?: string },
  waitMs: number = DELIVERY_ROW_WAIT_MS,
): Promise<AnswerOwedRead> {
  if (!input.runId) return { owed: false, why: "the run names no run id" };
  const person = await personOfRun(input.runId, waitMs);
  if (!person) return { owed: false, why: "the run carries no occurrence" };
  if (!person.leadId) return { owed: false, why: "the occurrence names no lead" };
  const read = await waitingOnUs(input.orgId, person.brandId, person.leadId);
  if (!read.ok) {
    console.error(`[campaign-service] answer-owed: could not ask lead-service whether lead ${person.leadId} waits on us (run ${input.runId}): ${read.detail}`);
    return { owed: false, why: `lead-service unreadable (${read.detail})` };
  }
  if (!read.waiting) return { owed: false, why: "the person is not waiting on our answer" };
  const answer = { leadId: person.leadId, brandId: person.brandId };
  const pass = await grantPass({ orgId: input.orgId, campaignId: input.campaignId, runId: input.runId, ...answer });
  if (!pass.ok) {
    console.error(`[campaign-service] answer-owed: billing refused the answer pass for run ${input.runId} (lead ${person.leadId}): ${pass.detail}`);
    return { owed: false, why: `billing pass not granted (${pass.detail})` };
  }
  return { owed: true, answer };
}
