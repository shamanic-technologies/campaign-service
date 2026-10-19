import type { Campaign } from "../db/schema.js";
import { canonicalPhone } from "./e164-phone.js";
import {
  canonicalEmail,
  fileNamedPerson,
  LEAD_SERVICE_UNAVAILABLE,
  scheduleNamedPersonDue,
  type PersonStatement,
} from "./sales-funnel-people.js";

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
 *     to `PERSON_NOT_KNOWN_WAIT_MS` after it occurred, then recorded skipped `person_not_known`.
 *     The occurrence ITSELF is the org naming the person for its own brand (PUSHED-PERSON-KNOWN-1014,
 *     owner 2026-10-14: a client pushing an email it wrote, with its own key, about someone it found
 *     itself), so the filing carries it as `statedBy {triggerEventId, triggerId}` + the person's name:
 *     lead-service records that statement as the evidence the brand knows them and files a person it
 *     never saw, after the suppression a serve applies (an unsubscribed / bounced / opted-out /
 *     do-not-contact person is skipped `person_suppressed`, never retried). Any trigger, no branch. Same
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
  /**
   * Canonical (trimmed, lowercased). The key lead-service files and identifies the person on. Null = a
   * person known only by PHONE (REPLY-PHONE-ONLY-1015: a WhatsApp writer): filed and made due by `phone`.
   */
  email: string | null;
  name?: string | null;
  /** As stated; canonical E.164 (`+447700900123`) when it is the identity (no email). */
  phone?: string | null;
  /** IANA zone the client STATED for the person (validated at the door); absent = none stated, never guessed here. */
  timezone?: string | null;
  /** The contact in the brand's own CRM the person came from, carried verbatim. */
  crmContact?: { provider: string; contactId: string } | null;
}

/** How soon an event held back for a passing reason (`PERSON_EVENT_RETRY_SKIPS`) is tried again, while young. */
export const PERSON_NOT_KNOWN_RETRY_MS = 2 * 60_000;
/** How long after it FELL DUE (or was last redelivered) an event stays young (short retry; `person_not_known` deadline). */
export const PERSON_NOT_KNOWN_WAIT_MS = 60 * 60_000;
/** Once no longer young, an event still owed for money or pacing is tried again on this delay, until room returns. */
export const OWED_EVENT_RECHECK_MS = 10 * 60_000;

/**
 * NEVER A DEAD END FOR MONEY OR PACING (owner 2026-10-14, NEVER-NO-FOLLOWUP-1014: « qu'on ne se retrouve jamais
 * dans une situation de non-followup, sauf évidemment si unsubscribe, unqualified, opt-out, ou si on a une
 * réponse positive »). A dated occurrence may be the ONLY thing carrying a person to their next message (the
 * follow-up chain records its next date as an occurrence). A campaign that cannot run it NOW only because of
 * money or pacing (its cap reached until the period rolls over, not funded yet, a run of it or its cohort in
 * flight, a failure backoff, a budget read billing could not answer) still OWES it: the occurrence stays
 * `pending` for that campaign with NO deadline, and fires once the campaign can run, exactly once. A customer's
 * Off (`campaign_off`) and every verdict about the PERSON (suppressed...) stay final.
 */
export const OWED_UNTIL_ROOM_SKIPS: ReadonlySet<string> = new Set([
  "run_in_flight",
  "cohort_run_in_flight",
  // The campaign waits out a failure backoff: the person was never made due, so nothing else would
  // answer them (prod 2026-10-12, staff probe).
  "failure_backoff",
  // Not funded YET (a client funding it right after pushing, or a cap written a second after the funnel was born).
  "unfunded",
  // billing could not answer for a funnel's caps: held fail-closed, never a verdict (FORM-ANSWER-NOBODY-DUE-1014).
  "sales_funnel_caps_unavailable",
  // The funnel's cap is reached (a $10/month reactive funnel): owed until its period rolls over or the cap is raised.
  "sales_funnel_cap",
]);

/**
 * The skips retried only while the event is YOUNG (`PERSON_NOT_KNOWN_WAIT_MS` since it fell due, every
 * `PERSON_NOT_KNOWN_RETRY_MS`), then the occurrence ends with that name (logged loud): the person not known to
 * the brand YET, and lead-service not answering (timeout, transport, 5xx: TRIGGER-TRANSIENT-FILING-1019; 4
 * occurrences lost in 7 days to one timeout, a WhatsApp number given among them). A definitive refusal
 * (`followup_unavailable`, `person_suppressed`...) is never here: final on the first try.
 */
export const YOUNG_ONLY_RETRY_SKIPS: ReadonlySet<string> = new Set(["person_not_known", LEAD_SERVICE_UNAVAILABLE]);

/**
 * The skips that make an event naming a person RETRY rather than record: every money / pacing hold
 * (`OWED_UNTIL_ROOM_SKIPS`, no deadline) + the young-only ones (`YOUNG_ONLY_RETRY_SKIPS`). The person is filed
 * and made due only right before a dispatch, so every such event gets its OWN run carrying its person and item,
 * never a later run that would claim them without what they asked.
 */
export const PERSON_EVENT_RETRY_SKIPS: ReadonlySet<string> = new Set([...OWED_UNTIL_ROOM_SKIPS, ...YOUNG_ONLY_RETRY_SKIPS]);

/** The caller's person, canonical. Pure. */
export function eventPerson(input: {
  email?: string;
  name?: string;
  phone?: string;
  timezone?: string;
  crmContact?: { provider: string; contactId: string };
}): EventPerson {
  const email = input.email ? canonicalEmail(input.email) : null;
  return {
    email,
    name: input.name?.trim() || null,
    // The identity of a phone-only person is its canonical E.164 spelling (validated at the door).
    phone: email ? input.phone?.trim() || null : input.phone ? canonicalPhone(input.phone) || null : null,
    // Present only when stated: a push stating none is byte-identical to before (row, `/execute`).
    ...(input.timezone?.trim() ? { timezone: input.timezone.trim() } : {}),
    crmContact: input.crmContact ?? null,
  };
}

/** The person stored on an event row's `detail.person`, read defensively (jsonb). Pure. */
export function storedEventPerson(value: unknown): EventPerson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const email = typeof r.email === "string" && r.email ? r.email : null;
  // A person with no email is identified by phone (REPLY-PHONE-ONLY-1015); neither = no person.
  if (!email && !(typeof r.phone === "string" && r.phone)) return null;
  const crm = r.crmContact && typeof r.crmContact === "object" ? (r.crmContact as Record<string, unknown>) : null;
  return {
    email,
    name: typeof r.name === "string" ? r.name : null,
    phone: typeof r.phone === "string" ? r.phone : null,
    ...(typeof r.timezone === "string" && r.timezone ? { timezone: r.timezone } : {}),
    crmContact: crm && typeof crm.provider === "string" && typeof crm.contactId === "string"
      ? { provider: crm.provider, contactId: crm.contactId }
      : null,
  };
}

export type EventPersonOwed =
  | { ok: true; leadId: string }
  | {
      ok: false;
      code:
        | "person_not_known"
        | "person_suppressed"
        | "ambiguous_person"
        | "person_not_filed"
        | "followup_unavailable"
        | "person_not_due"
        | typeof LEAD_SERVICE_UNAVAILABLE;
      detail: string;
    };

/**
 * File the event's person on `campaign` at lead-service, then make them due now on its follow-up queue.
 * Never throws: the caller names the skip.
 */
export async function oweEventPerson(
  campaign: Campaign,
  person: EventPerson,
  now: Date,
  statedBy?: PersonStatement | null,
): Promise<EventPersonOwed> {
  const filed = await fileNamedPerson({
    orgId: campaign.orgId,
    campaignId: campaign.id,
    email: person.email,
    userId: campaign.createdByUserId,
    runId: campaign.parentRunId,
    statedBy: statedBy ?? null,
    name: person.name ?? null,
    // What lead-service schedules every message to this person on (PUSHED-PERSON-TZ-1014): the phone the
    // client gave (a +44 number = UK) and the zone they stated, if any. No zone is ever made up here.
    phone: person.phone ?? null,
    timezone: person.timezone ?? null,
  });
  if (!filed.ok) {
    if (
      filed.code === "person_not_known" ||
      filed.code === "person_suppressed" ||
      filed.code === "ambiguous_person" ||
      filed.code === LEAD_SERVICE_UNAVAILABLE
    ) {
      return { ok: false, code: filed.code, detail: filed.detail };
    }
    return { ok: false, code: "followup_unavailable", detail: `${filed.code}: ${filed.detail}` };
  }
  const due = await scheduleNamedPersonDue({
    orgId: campaign.orgId,
    campaignId: campaign.id,
    email: person.email,
    phone: person.phone ?? null,
    now,
    statedBy: statedBy ?? null,
  });
  if (!due.ok) return { ok: false, code: due.code, detail: due.detail };
  return { ok: true, leadId: filed.leadId };
}

/** How a person is named in a log line or a skip detail: email, else phone. Pure. */
export function personLabel(person: Pick<EventPerson, "email" | "phone">): string {
  return person.email ?? person.phone ?? "an unidentified person";
}
