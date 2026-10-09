/**
 * What lead-service MEASURED about the people of one offer — the half of "did anything happen?" this
 * service does not record itself (lib/delay-trigger-detector.ts).
 *
 * One read per (org, brand, offer): `GET /orgs/leads?view=compact&brandId&offerId` (no `limit` =
 * every row of the offer, any campaign, any channel). Each row is a (person x campaign) membership,
 * so a person can appear several times; the answer is folded per PERSON (`leadId`): a reply, a click,
 * a bounce or an opt-out on ANY of their rows counts.
 *
 * FAIL LOUD: lead-service unreachable or non-2xx THROWS. The caller never reads "unreadable" as
 * "nothing happened": a message to someone who already answered is the harm this read prevents.
 */

export interface LeadActivity {
  /** Rows lead-service holds for this person in the offer. */
  rows: number;
  replied: boolean;
  clicked: boolean;
  bounced: boolean;
  unsubscribed: boolean;
  /** The customer's CRM evidences a positive reply, dated (the latest across rows). */
  crmPositiveReplyAt: string | null;
}

export type LeadActivityByLead = ReadonlyMap<string, LeadActivity>;

interface CompactRow {
  leadId?: unknown;
  replied?: unknown;
  clicked?: unknown;
  bounced?: unknown;
  unsubscribed?: unknown;
  crmPositiveReplyAt?: unknown;
}

export async function fetchOfferLeadActivity(scope: {
  orgId: string;
  brandId: string;
  offerId: string;
}): Promise<LeadActivityByLead> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY is not set");

  const params = new URLSearchParams({ view: "compact", brandId: scope.brandId, offerId: scope.offerId });
  const res = await fetch(`${url.replace(/\/$/, "")}/orgs/leads?${params}`, {
    headers: { "x-api-key": apiKey, "x-org-id": scope.orgId },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`lead-service GET /orgs/leads?view=compact failed: ${res.status}${body ? ` ${body}` : ""}`);
  }
  const data = (await res.json()) as { leads?: unknown };
  if (!Array.isArray(data.leads)) throw new Error("lead-service GET /orgs/leads?view=compact answered no leads array");
  return foldLeadActivity(data.leads as CompactRow[]);
}

/** Fold compact rows per person. Pure. */
export function foldLeadActivity(rows: readonly CompactRow[]): LeadActivityByLead {
  const out = new Map<string, LeadActivity>();
  for (const r of rows) {
    if (typeof r?.leadId !== "string" || r.leadId.length === 0) continue;
    let a = out.get(r.leadId);
    if (!a) {
      a = { rows: 0, replied: false, clicked: false, bounced: false, unsubscribed: false, crmPositiveReplyAt: null };
      out.set(r.leadId, a);
    }
    a.rows += 1;
    a.replied ||= r.replied === true;
    a.clicked ||= r.clicked === true;
    a.bounced ||= r.bounced === true;
    a.unsubscribed ||= r.unsubscribed === true;
    if (typeof r.crmPositiveReplyAt === "string" && (!a.crmPositiveReplyAt || r.crmPositiveReplyAt > a.crmPositiveReplyAt)) {
      a.crmPositiveReplyAt = r.crmPositiveReplyAt;
    }
  }
  return out;
}
