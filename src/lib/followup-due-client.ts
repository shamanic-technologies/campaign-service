/**
 * WHO IS OWED on a set of follow-up queues, lead-service's answer (WA-REACTIVE-LOOP-1016). Read-only: lead-service
 * claims nothing and writes nothing for it. Read by lib/reactive-wake.ts so a reactive campaign runs only when
 * somebody is owed.
 *
 * FAIL LOUD: unreachable / non-2xx / unparseable THROWS ("could not read" is never "nobody owed").
 */

export interface FollowupDue {
  /** Someone on one of the queues is owed an answer now. */
  owedNow: boolean;
  /** The earliest moment someone becomes owed, when nobody is owed now; null = nobody scheduled. */
  nextDueAt: Date | null;
}

function leadServiceBase(): { url: string; apiKey: string } {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY is not set");
  return { url: url.replace(/\/$/, ""), apiKey };
}

/**
 * Parse lead-service's answer for ONE acting campaign (`answers[]` entry naming it). Pure; throws on a malformed
 * answer or one that does not name the campaign asked about.
 */
export function parseFollowupDue(data: unknown, campaignId: string): FollowupDue {
  const answers = (data as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(answers)) throw new Error(`lead-service followups owed answered no answers array: ${JSON.stringify(data).slice(0, 200)}`);
  const a = (answers as Array<Record<string, unknown>>).find((x) => x?.campaignId === campaignId);
  if (!a) throw new Error(`lead-service followups owed answered nothing for campaign ${campaignId}`);
  if (typeof a.owedNow !== "boolean") throw new Error(`lead-service followups owed answered no owedNow: ${JSON.stringify(a).slice(0, 200)}`);
  let nextDueAt: Date | null = null;
  if (typeof a.nextOwedAt === "string") {
    nextDueAt = new Date(a.nextOwedAt);
    if (Number.isNaN(nextDueAt.getTime())) throw new Error(`lead-service followups owed answered a bad nextOwedAt: ${a.nextOwedAt}`);
  } else if (a.nextOwedAt !== null && a.nextOwedAt !== undefined) {
    throw new Error(`lead-service followups owed answered a bad nextOwedAt: ${JSON.stringify(a.nextOwedAt)}`);
  }
  return { owedNow: a.owedNow, nextDueAt };
}

export async function fetchFollowupDue(input: {
  orgId: string;
  /** The reactive campaign that would claim. */
  actingCampaignId: string;
  /** Every queue it answers, its own first. */
  campaignIds: string[];
}): Promise<FollowupDue> {
  const { url, apiKey } = leadServiceBase();
  const res = await fetch(`${url}/internal/followups/owed`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "x-org-id": input.orgId },
    body: JSON.stringify({ campaigns: [{ campaignId: input.actingCampaignId, heldCampaignIds: input.campaignIds }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`lead-service POST /internal/followups/owed failed: ${res.status}${body ? ` ${body}` : ""}`);
  }
  return parseFollowupDue(await res.json(), input.actingCampaignId);
}
