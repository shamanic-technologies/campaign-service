/**
 * DID THE BRAND WRITE TO THIS PERSON AFTER T? crm-service holds the conversation (UNSENT-ANSWERED-ELSEWHERE-1103).
 *
 * The Monitoring "Unsent answers" card must stay green for a person the brand answered OUTSIDE a campaign run: prod
 * 2026-11-02, Sophie (the AI WhatsApp line) answered Senthil at 15:08 while the Lead Proposal campaign's runs found
 * nothing to do. crm-service reads every thread of the person (Gmail, cold email, WhatsApp / Telegram via its Matrix
 * mirror, our WhatsApp sends, Copilot / API / transactional): `POST /internal/people/sent-after` (crm-service #243),
 * stored data only, no cost. One ask per occurrence, named by what it carries (email, phone, the item's relation key /
 * human), each with its own T. Answer per ask: `sent` (+ `firstSent.sentBy` automation | person | null) |
 * `nothing_sent` | `unreadable` | `unknown`; only `sent` changes a verdict here.
 *
 * THROWS when crm-service cannot be read: the caller keeps its verdict (never hides a red on an outage).
 */

export interface SentAfterAsk {
  ref: string;
  after: string;
  email?: string;
  phone?: string;
  relationKey?: string;
  humanId?: string;
}

export interface SentAfterVerdict {
  ref: string;
  status: "sent" | "nothing_sent" | "unreadable" | "unknown";
  /** Who sent the first message after T: one of our machines, a human of the brand, or unknown. */
  sentBy: "automation" | "person" | null;
  firstSentAt: string | null;
}

/** crm-service caps one read at this many people. */
export const SENT_AFTER_BATCH = 200;
const TIMEOUT_MS = 20_000;

export async function fetchSentAfter(orgId: string, brandId: string, asks: SentAfterAsk[]): Promise<SentAfterVerdict[]> {
  if (asks.length === 0) return [];
  const url = process.env.CRM_SERVICE_URL;
  const apiKey = process.env.CRM_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CRM_SERVICE_URL / CRM_SERVICE_API_KEY not set");
  const out: SentAfterVerdict[] = [];
  for (let i = 0; i < asks.length; i += SENT_AFTER_BATCH) {
    const batch = asks.slice(i, i + SENT_AFTER_BATCH);
    const res = await fetch(`${url.replace(/\/$/, "")}/internal/people/sent-after`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ orgId, brandId, people: batch }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`crm-service sent-after ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      people?: Array<{ ref: string | null; status: SentAfterVerdict["status"]; firstSent: { at: string; sentBy: SentAfterVerdict["sentBy"] } | null }>;
    };
    if (!Array.isArray(body.people)) throw new Error("crm-service sent-after answered no people[]");
    for (const p of body.people) {
      if (!p.ref) continue;
      out.push({ ref: p.ref, status: p.status, sentBy: p.firstSent?.sentBy ?? null, firstSentAt: p.firstSent?.at ?? null });
    }
  }
  return out;
}
