import { createRun, updateRun, type IdentityHeaders } from "@distribute/runs-client";

/**
 * ONE metered treg call, ORG-billed on a campaign (the poll detector's source read,
 * lib/poll-trigger-detector.ts). The fleet cost contract, exactly as apollo-service meters treg:
 *
 *   key-service `treg` + `treg-org` (the org's own key, else the platform's)
 *   → a child run of the campaign's ancestor run (`campaign-service / trigger-poll`)
 *   → PROVISION the call's ceiling (`treg-micro-usd`, quantity = micro-USD)
 *   → AUTHORIZE it at billing (platform key only; insufficient = no call, hold cancelled)
 *   → EXECUTE
 *   → ACTUALIZE treg's own `X-Treg-Cost-Micro`, then cancel the hold.
 *
 * Fail LOUD: a 200 without a cost header throws (the charge cannot be declared); a call that never
 * answered leaves its hold provisioned (it may have been billed) and says so with the ids.
 */

export const TREG_COST_NAME = "treg-micro-usd";
const DEFAULT_TREG_BASE = "https://treg.to/call/";
const CALL_TIMEOUT_MS = 60_000;

export interface TregCallRequest {
  endpoint: string;
  method: "GET" | "POST";
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  /** The ceiling provisioned and authorized for the call, micro-USD. */
  maxMicro: number;
}

export interface TregAnswer {
  status: number;
  body: unknown;
  chargedMicro: number;
  runId: string;
}

export interface TregBilling {
  orgId: string;
  userId: string;
  brandId: string;
  campaignId: string;
  featureSlug: string;
  /** The campaign's ancestor run (lib/trigger-run.ts): the metering run is its child. */
  parentRunId: string;
  /** What the call is for, on the billing line. */
  description: string;
}

export class TregInsufficientCreditError extends Error {
  constructor(readonly balanceCents: number, readonly requiredCents: number) {
    super(`insufficient credit for a treg call (balance ${balanceCents}c, required ${requiredCents}c)`);
    this.name = "TregInsufficientCreditError";
  }
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function decryptKey(provider: string, billing: TregBilling): Promise<{ key: string; keySource: "org" | "platform" }> {
  const res = await fetch(`${env("KEY_SERVICE_URL").replace(/\/$/, "")}/keys/${provider}/decrypt`, {
    headers: {
      "X-API-Key": env("KEY_SERVICE_API_KEY"),
      "X-Caller-Service": "campaign",
      "X-Caller-Method": "POST",
      "X-Caller-Path": "/internal/trigger-detectors/poll",
      "x-org-id": billing.orgId,
      "x-user-id": billing.userId,
      "x-brand-id": billing.brandId,
      "x-campaign-id": billing.campaignId,
      "x-feature-slug": billing.featureSlug,
    },
  });
  if (!res.ok) throw new Error(`key-service ${provider} decrypt failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { key?: unknown; keySource?: unknown };
  if (typeof data.key !== "string" || (data.keySource !== "org" && data.keySource !== "platform")) {
    throw new Error(`key-service ${provider} decrypt answered no key/keySource`);
  }
  return { key: data.key, keySource: data.keySource };
}

function identityOf(billing: TregBilling, runId: string): Record<string, string> {
  return {
    "x-org-id": billing.orgId,
    "x-user-id": billing.userId,
    "x-run-id": runId,
    "x-brand-id": billing.brandId,
    "x-campaign-id": billing.campaignId,
    "x-feature-slug": billing.featureSlug,
  };
}

async function runsCall<T>(path: string, method: "POST" | "PATCH", body: unknown, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`${env("RUNS_SERVICE_URL").replace(/\/$/, "")}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-API-Key": env("RUNS_SERVICE_API_KEY"), ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`runs-service ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function addCost(runId: string, billing: TregBilling, item: { costSource: string; quantity: number; status?: "provisioned" }) {
  const result = await runsCall<{ costs?: Array<{ id: string }> }>(
    `/v1/runs/${runId}/costs`,
    "POST",
    { items: [{ costName: TREG_COST_NAME, ...item, idempotencyKey: `campaign-service:cost:${crypto.randomUUID()}` }] },
    identityOf(billing, runId),
  );
  return result.costs?.[0]?.id ?? null;
}

async function cancelCost(runId: string, costId: string, billing: TregBilling): Promise<void> {
  await runsCall(`/v1/runs/${runId}/costs/${costId}`, "PATCH", { status: "cancelled" }, identityOf(billing, runId));
}

async function authorize(billing: TregBilling, runId: string, maxMicro: number) {
  const res = await fetch(`${env("BILLING_SERVICE_URL").replace(/\/$/, "")}/v1/customer_balance/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": env("BILLING_SERVICE_API_KEY"), ...identityOf(billing, runId) },
    body: JSON.stringify({ items: [{ costName: TREG_COST_NAME, quantity: maxMicro }], description: billing.description }),
  });
  if (!res.ok) throw new Error(`billing-service authorize failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { sufficient: boolean; balance_cents: number; required_cents: number };
}

export async function meteredTregCall(billing: TregBilling, req: TregCallRequest): Promise<TregAnswer> {
  const token = await decryptKey("treg", billing);
  const org = await decryptKey("treg-org", billing);
  const identity: IdentityHeaders = {
    orgId: billing.orgId,
    userId: billing.userId,
    brandId: billing.brandId,
    campaignId: billing.campaignId,
    featureSlug: billing.featureSlug,
  };
  const run = await createRun({
    ...identity,
    parentRunId: billing.parentRunId,
    serviceName: "campaign-service",
    taskName: "trigger-poll",
  });

  let holdId: string | null = null;
  let answered = false;
  try {
    holdId = await addCost(run.id, billing, { costSource: token.keySource, quantity: req.maxMicro, status: "provisioned" });
    if (!holdId) throw new Error(`runs-service returned no cost id for the ${TREG_COST_NAME} hold`);
    if (token.keySource === "platform") {
      const auth = await authorize(billing, run.id, req.maxMicro);
      if (!auth.sufficient) {
        await cancelCost(run.id, holdId, billing);
        answered = true;
        throw new TregInsufficientCreditError(auth.balance_cents, auth.required_cents);
      }
    }

    const base = (process.env.TREG_CALL_BASE_URL || DEFAULT_TREG_BASE).replace(/\/?$/, "/");
    const url = `${base}${req.endpoint}${req.query && Object.keys(req.query).length > 0 ? `?${new URLSearchParams(req.query)}` : ""}`;
    const headers: Record<string, string> = { "X-Treg-Token": token.key, "X-Treg-Org": org.key, "Cache-Control": "no-cache" };
    if (req.body) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
      method: req.method,
      headers,
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { _raw: text.slice(0, 2000) };
    }
    const costHeader = response.headers.get("x-treg-cost-micro");
    let charged = costHeader === null || costHeader.trim() === "" ? null : Number(costHeader);
    if (charged !== null && !Number.isFinite(charged)) charged = null;
    if (charged === null) {
      if (response.ok) throw new Error(`treg ${req.endpoint} answered ${response.status} without X-Treg-Cost-Micro: the charge cannot be declared`);
      charged = 0; // treg bills nothing for a relayed failure
    }
    if (charged > 0) await addCost(run.id, billing, { costSource: token.keySource, quantity: charged });
    await cancelCost(run.id, holdId, billing);
    answered = true;
    await updateRun(run.id, response.ok ? "completed" : "failed", { ...identity, runId: run.id });
    return { status: response.status, body, chargedMicro: charged, runId: run.id };
  } catch (err) {
    if (holdId && !answered) {
      console.error(
        `[campaign-service] treg ${req.endpoint} hold ${holdId} on run ${run.id} left PROVISIONED (the call may have been billed):`,
        err instanceof Error ? err.message : err,
      );
    }
    await updateRun(run.id, "failed", { ...identity, runId: run.id }).catch((e) =>
      console.error(`[campaign-service] treg metering run ${run.id} could not be marked failed:`, e),
    );
    throw err;
  }
}
