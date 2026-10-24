/**
 * JEV (chat-service typed judgments): one yes/no question about one piece of text, answered with the
 * probability of yes. Platform-billed (`/internal/platform-judgments`): every caller here is a background sweep
 * with no user. chat-service declares the cost (input tokens only). Fail-loud: a missing env var, a non-2xx or an
 * answer without a probability throws.
 *
 * WHOSE WORK (PLATFORM-CALLER-RUN-1024, chat-service COST-SUPPORT-1024): every call states exactly ONE of
 *  - `{ runId }`: OUR run doing the work, sent as `x-run-id` (the platform run becomes its child, the spend rides
 *    the outcome that run's tree produces). The default whenever the work is production. Never a run id read off
 *    an inbound request or another service's row: only a run campaign-service opened for this work.
 *  - `{ support }`: a declared support function, only when no run stands behind the call by design.
 * Both or neither is not expressible here (chat-service 400s both and will 400 neither).
 */
export type SupportKind =
  | "payment_fees"
  | "brand_setup"
  | "copilot"
  | "platform_llm"
  | "staff_experiment"
  | "product_feature"
  | "retired_product";

export type JevCaller = { runId: string; support?: never } | { support: { kind: SupportKind; reason: string }; runId?: never };

/** The headers + body fields a platform call carries for its caller. Pure. */
export function platformCallerParts(caller: JevCaller): { headers: Record<string, string>; body: Record<string, unknown> } {
  if (caller.runId) return { headers: { "x-run-id": caller.runId }, body: {} };
  if (caller.support) return { headers: {}, body: { support: caller.support } };
  throw new Error("a chat-service platform call must state its caller run or a support function");
}
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

const JEV_TIMEOUT_MS = 30_000;

/** P(yes) for `question` on `state`, 0..1. */
export async function judgeNoul(state: Record<string, unknown>, question: NoulQuestion, caller: JevCaller): Promise<number> {
  const url = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured: Jev cannot be asked");
  const parts = platformCallerParts(caller);
  const res = await fetch(`${url.replace(/\/$/, "")}/internal/platform-judgments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey, ...parts.headers },
    body: JSON.stringify({ state, questions: { q: question }, ...parts.body }),
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
