import type { Campaign } from "../db/schema.js";
import { canonicalEmail, fileNamedPerson, scheduleNamedPersonDue } from "./sales-funnel-people.js";

/**
 * AN EVENT THAT NAMES A PERSON BY WHO THEY ARE (2026-10-12, FORM-TRIGGER-1012).
 *
 * A trigger occurrence (`POST /internal/trigger-events`) may name the person it is about by IDENTITY
 * (`person`: email, name, phone, the CRM contact it came from) and carry what they asked (`item`: any
 * JSON, e.g. a form's name, answers and submission time), not only by a lead id. Owner: homogeneous
 * infra, so this is a capability of EVERY trigger, never a `form_submitted` branch (the first caller is
 * crm-service reporting a new CRM form submission; anyone reporting an occurrence about a person who
 * may not be a lead yet uses the same door).
 *
 * What it does, per campaign the trigger reaches, once that campaign's money allows a run (a capped or
 * unfunded campaign owes nobody anything):
 *  1. FILE the person as a lead of the campaign's brand on that campaign at lead-service
 *     (`POST /orgs/campaigns/:id/leads/by-email`): exactly what a serve writes, so serving, dedup,
 *     outcomes and attribution see them with no consumer change. lead-service files only people the
 *     brand KNOWS (a live fact of its CRM copy): a person whose CRM fact has not reached lead-service
 *     yet is `person_not_known`, and the EVENT is retried shortly (`PERSON_NOT_KNOWN_RETRY_MS`) for up
 *     to `PERSON_NOT_KNOWN_WAIT_MS` after it occurred, then recorded skipped `person_not_known`. Same
 *     retry when a run of the campaign or its cohort is in flight (`PERSON_EVENT_RETRY_SKIPS`): steps 1-2
 *     happen only once nothing holds the dispatch back, so every event gets its OWN run;
 *  2. make them DUE now on that campaign's own follow-up queue (`schedule-by-email`), so the workflow
 *     claims exactly them, once, and a dispatch skipped this instant (run in flight) leaves a durable
 *     debt the campaign's next run claims;
 *  3. dispatch, the person and the item riding `/execute` as `trigger {eventId, triggerId, leadId,
 *     item, person}` (leadId = the lead lead-service filed them as).
 *
 * A campaign that names its own people (lib/sales-funnel-people.ts) answers such an event only when the
 * person is one of them.
 */

export interface EventPerson {
  /** Canonical (trimmed, lowercased). The key lead-service files and identifies the person on. */
  email: string;
  name?: string | null;
  phone?: string | null;
  /** The contact in the brand's own CRM the person came from, carried verbatim. */
  crmContact?: { provider: string; contactId: string } | null;
}

/** How soon an event held back for a passing reason (`PERSON_EVENT_RETRY_SKIPS`) is tried again. */
export const PERSON_NOT_KNOWN_RETRY_MS = 2 * 60_000;
/** How long after it occurred such an event keeps being retried before its skip is recorded. */
export const PERSON_NOT_KNOWN_WAIT_MS = 60 * 60_000;
/**
 * The skips that make an event naming a person RETRY rather than record: the person is not known to the
 * brand yet, a run of the campaign (or its cohort) is in flight, or the campaign waits out a failure backoff. The person is filed and made due only
 * right before a dispatch, so every such event gets its OWN run carrying its person and item, never a
 * later run that would claim them without what they asked.
 */
export const PERSON_EVENT_RETRY_SKIPS: ReadonlySet<string> = new Set([
  "person_not_known",
  "run_in_flight",
  "cohort_run_in_flight",
  // The campaign waits out a failure backoff: the person was never made due, so nothing else would
  // answer them; the event retries until the backoff ends (prod 2026-10-12, staff probe).
  "failure_backoff",
]);

/** The caller's person, canonical. Pure. */
export function eventPerson(input: {
  email: string;
  name?: string;
  phone?: string;
  crmContact?: { provider: string; contactId: string };
}): EventPerson {
  return {
    email: canonicalEmail(input.email),
    name: input.name?.trim() || null,
    phone: input.phone?.trim() || null,
    crmContact: input.crmContact ?? null,
  };
}

/** The person stored on an event row's `detail.person`, read defensively (jsonb). Pure. */
export function storedEventPerson(value: unknown): EventPerson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.email !== "string" || !r.email) return null;
  const crm = r.crmContact && typeof r.crmContact === "object" ? (r.crmContact as Record<string, unknown>) : null;
  return {
    email: r.email,
    name: typeof r.name === "string" ? r.name : null,
    phone: typeof r.phone === "string" ? r.phone : null,
    crmContact: crm && typeof crm.provider === "string" && typeof crm.contactId === "string"
      ? { provider: crm.provider, contactId: crm.contactId }
      : null,
  };
}

export type EventPersonOwed =
  | { ok: true; leadId: string }
  | {
      ok: false;
      code: "person_not_known" | "ambiguous_person" | "person_not_filed" | "followup_unavailable";
      detail: string;
    };

/**
 * File the event's person on `campaign` at lead-service, then make them due now on its follow-up queue.
 * Never throws: the caller names the skip.
 */
export async function oweEventPerson(campaign: Campaign, person: EventPerson, now: Date): Promise<EventPersonOwed> {
  const filed = await fileNamedPerson({
    orgId: campaign.orgId,
    campaignId: campaign.id,
    email: person.email,
    userId: campaign.createdByUserId,
    runId: campaign.parentRunId,
  });
  if (!filed.ok) {
    if (filed.code === "person_not_known" || filed.code === "ambiguous_person") return { ok: false, code: filed.code, detail: filed.detail };
    return { ok: false, code: "followup_unavailable", detail: `${filed.code}: ${filed.detail}` };
  }
  const due = await scheduleNamedPersonDue({ orgId: campaign.orgId, campaignId: campaign.id, email: person.email, now });
  if (!due.ok) return { ok: false, code: due.code, detail: due.detail };
  return { ok: true, leadId: filed.leadId };
}
