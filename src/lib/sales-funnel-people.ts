import type { Campaign } from "../db/schema.js";

/**
 * A SALES FUNNEL CAMPAIGN THAT NAMES ITS PEOPLE (2026-10-11, COPILOT-FOLLOWUP-CAMPAIGN-1011).
 *
 * Two GENERAL capabilities of any funnel campaign (owner: homogeneous infra, never a caller-only branch,
 * never a per-feature selector). The first caller is the distribute.you Copilot following up ONE person
 * on our own brand ("give Marie her exact cost per booked meeting when it is known"), but nothing here
 * knows about it.
 *
 *  - PEOPLE (`people`, [{email, leadId}]): the exact people the campaign acts for. NULL = whoever its
 *    pipes serve, every campaign before this. A campaign naming people:
 *      * runs only REACTIVE pipes (a pipe that prospects new people would act on strangers; refused
 *        at launch, `people_need_reactive_funnel`);
 *      * is its own identity: `people_key` (sorted lowercased emails) joins (org, brand, offer, funnel),
 *        so the same funnel naming another person is another campaign, the same person again is the
 *        same campaign (owner rule 2, handed back, never created twice);
 *      * on an EVENT its pipe answers, makes its people DUE on that unit's own follow-up queue at
 *        lead-service (`schedule-by-email`, dueAt now) before the dispatch, so the workflow claims
 *        exactly them, once (lead-service's atomic claim), and a dispatch skipped this instant (run in
 *        flight, cohort busy) leaves a durable debt the unit's next run claims;
 *      * is never rationed against another campaign on a shared pipe (different people, no double
 *        answer to fear); an event naming a lead acts only for the campaign that names that lead.
 *  - INSTRUCTION (`instruction`): free text every run of its units carries to the workflow (/start-run
 *    answers it top-level), read at each run, so an edit is what the next message follows.
 *
 * Money is unchanged: a unit's money is its funnel's caps at billing; status is the caller's statement.
 */

export interface NamedPerson {
  email: string;
  /** lead-service's lead id once the person is filed under the campaign; null until then. */
  leadId: string | null;
}

export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The people a caller named, canonical and deduplicated, in a stable order. Pure. */
export function namedPeople(input: ReadonlyArray<{ email: string }>): NamedPerson[] {
  const emails = [...new Set(input.map((p) => canonicalEmail(p.email)))].sort();
  return emails.map((email) => ({ email, leadId: null }));
}

/** The identity of a set of named people ('' = names nobody). Pure. */
export function peopleKeyOf(people: ReadonlyArray<{ email: string }> | null | undefined): string {
  if (!people || people.length === 0) return "";
  return [...new Set(people.map((p) => canonicalEmail(p.email)))].sort().join(",");
}

/** The stored `people` column, read defensively (jsonb). null = the campaign names nobody. */
export function storedPeople(value: unknown): NamedPerson[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: NamedPerson[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { email?: unknown; leadId?: unknown };
    if (typeof r.email !== "string" || !r.email) continue;
    out.push({ email: r.email, leadId: typeof r.leadId === "string" && r.leadId ? r.leadId : null });
  }
  return out.length > 0 ? out : null;
}

export interface SalesFunnelCampaignTargeting {
  people: NamedPerson[] | null;
  instruction: string | null;
  /** The GitHub issue it waits on (`owner/repo#n`, lib/github-issue-trigger.ts), or null. */
  githubIssue: string | null;
}

/** The people a UNIT acts for (its funnel campaign's), or null when it names nobody. */
export function unitPeople(
  unit: Pick<Campaign, "salesFunnelCampaignId">,
  targeting: ReadonlyMap<string, SalesFunnelCampaignTargeting>,
): NamedPerson[] | null {
  if (!unit.salesFunnelCampaignId) return null;
  return targeting.get(unit.salesFunnelCampaignId)?.people ?? null;
}

/**
 * Does an event naming `eventLeadId` concern a campaign naming `people`? An event naming nobody (a
 * figure became available) concerns every campaign its trigger reaches; an event naming a lead
 * concerns only the campaign that names that lead (a lead not filed yet cannot be matched). Pure.
 */
export function eventConcernsPeople(people: readonly NamedPerson[], eventLeadId: string | null | undefined): boolean {
  if (!eventLeadId) return true;
  return people.some((p) => p.leadId === eventLeadId);
}

export type ScheduleDueOutcome =
  | { ok: true }
  | { ok: false; code: "person_not_filed" | "ambiguous_person" | "followup_unavailable"; detail: string };

/**
 * Make ONE named person due NOW on a unit's own follow-up queue at lead-service (`schedule-by-email`).
 * 404 = the person holds no row on this campaign yet (not filed), 409 = the address matches several
 * rows; every other failure is `followup_unavailable`. Never throws: the caller names the skip.
 */
export async function scheduleNamedPersonDue(input: {
  orgId: string;
  campaignId: string;
  email: string;
  now?: Date;
}): Promise<ScheduleDueOutcome> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) {
    return { ok: false, code: "followup_unavailable", detail: "LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY is not set" };
  }
  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/orgs/campaigns/${encodeURIComponent(input.campaignId)}/followups/schedule-by-email`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "x-org-id": input.orgId },
        body: JSON.stringify({ email: input.email, dueAt: (input.now ?? new Date()).toISOString() }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (res.ok) return { ok: true };
    const body = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 404) return { ok: false, code: "person_not_filed", detail: `lead-service 404 ${body}` };
    if (res.status === 409) return { ok: false, code: "ambiguous_person", detail: `lead-service 409 ${body}` };
    return { ok: false, code: "followup_unavailable", detail: `lead-service ${res.status} ${body}` };
  } catch (err) {
    return { ok: false, code: "followup_unavailable", detail: err instanceof Error ? err.message : String(err) };
  }
}

export type FileNamedPersonOutcome =
  | { ok: true; leadId: string; filed: boolean }
  | {
      ok: false;
      code: "person_not_known" | "ambiguous_person" | "campaign_has_no_brand" | "filing_unavailable";
      detail: string;
    };

/**
 * FILE one named person under a unit at lead-service (`POST /orgs/campaigns/:id/leads/by-email`): the
 * person becomes a lead of the campaign's brand on that unit, with no purchase and no serve (lead-service
 * refuses an address its brand does not know: `person_not_known`). Idempotent there (201 filed, 200
 * already filed). Never throws: the caller names the outcome.
 */
export async function fileNamedPerson(input: {
  orgId: string;
  campaignId: string;
  email: string;
  userId?: string | null;
  runId?: string | null;
}): Promise<FileNamedPersonOutcome> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) {
    return { ok: false, code: "filing_unavailable", detail: "LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY is not set" };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-api-key": apiKey, "x-org-id": input.orgId };
  if (input.userId) headers["x-user-id"] = input.userId;
  if (input.runId) headers["x-run-id"] = input.runId;
  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/orgs/campaigns/${encodeURIComponent(input.campaignId)}/leads/by-email`,
      { method: "POST", headers, body: JSON.stringify({ email: input.email }), signal: AbortSignal.timeout(30_000) },
    );
    const text = await res.text().catch(() => "");
    if (res.ok) {
      const body = JSON.parse(text) as { leadId?: unknown; status?: unknown };
      if (typeof body.leadId !== "string" || !body.leadId) {
        return { ok: false, code: "filing_unavailable", detail: `lead-service ${res.status} answered no leadId` };
      }
      return { ok: true, leadId: body.leadId, filed: body.status === "filed" };
    }
    const code = (() => {
      try { return (JSON.parse(text) as { code?: unknown }).code; } catch { return undefined; }
    })();
    const detail = `lead-service ${res.status} ${text.slice(0, 300)}`;
    if (code === "person_not_known") return { ok: false, code: "person_not_known", detail };
    if (code === "ambiguous_lead") return { ok: false, code: "ambiguous_person", detail };
    if (code === "campaign_has_no_brand") return { ok: false, code: "campaign_has_no_brand", detail };
    return { ok: false, code: "filing_unavailable", detail };
  } catch (err) {
    return { ok: false, code: "filing_unavailable", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** The people with the lead ids filing answered, matched by email. Pure. */
export function withFiledLeadIds(people: readonly NamedPerson[], filed: ReadonlyMap<string, string>): NamedPerson[] {
  return people.map((p) => ({ email: p.email, leadId: filed.get(p.email) ?? p.leadId }));
}
