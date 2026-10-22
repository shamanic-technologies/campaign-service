/**
 * JEV (chat-service typed judgments): one yes/no question about one piece of text, answered with the
 * probability of yes. Platform-billed (`/internal/platform-judgments`): every caller here is a background sweep
 * with no user. chat-service declares the cost (input tokens only). Fail-loud: a missing env var, a non-2xx or an
 * answer without a probability throws.
 */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

const JEV_TIMEOUT_MS = 30_000;

/** P(yes) for `question` on `state`, 0..1. */
export async function judgeNoul(state: Record<string, unknown>, question: NoulQuestion): Promise<number> {
  const url = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured: Jev cannot be asked");
  const res = await fetch(`${url.replace(/\/$/, "")}/internal/platform-judgments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ state, questions: { q: question } }),
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`chat-service POST /internal/platform-judgments answered ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { answers?: Record<string, { type?: unknown; noul?: unknown }> };
  const answer = body.answers?.q;
  if (!answer || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
    throw new Error(`chat-service judgment answered without a yes/no probability: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return answer.noul;
}
