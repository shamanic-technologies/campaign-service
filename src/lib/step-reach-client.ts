/**
 * WHO REACHED A STEP, and when — lead-service's answer (FACT-NOT-FOLLOWED-1014).
 *
 * A "fact not followed" delay trigger (lib/delay-trigger-detector.ts, params `unlessStep`) anchors on the
 * PEOPLE of a brand who reached `afterStep` (a signup in the auth provider or analytics, a visit, a payment:
 * the facts every client plugs through its own connectors), and is cancelled when the person has EVER
 * reached `unlessStep`. What a connector fact MEANS as a catalogue step is lead-service's (its copy of
 * crm-service's people fact feed + its outcome ledger); this service never reads a CRM fact itself.
 *
 * FAIL LOUD: unreachable / non-2xx / unparseable THROWS. "Could not read" is never "nobody reached it"
 * (a planner) nor "never reached it" (a guard: writing to someone who already paid is the harm).
 */

export interface StepReacher {
  /** Canonical (lowercased) email: a person with none cannot be written to and is never listed. */
  email: string;
  name: string | null;
  phone: string | null;
  /** When they reached the step (the earliest reach inside the asked window). */
  reachedAt: Date;
}

/**
 * lead-service's named refusal for a step no store of its own sees per person (`step_not_observable`) or does not know
 * (`unknown_step`): a fact about the step cannot be read there at all, which is never "nobody reached it".
 */
export class StepNotObservableError extends Error {
  constructor(readonly step: string, readonly code: string) {
    super(`lead-service cannot observe step "${step}" (${code})`);
    this.name = "StepNotObservableError";
  }
}

function leadServiceBase(): { url: string; apiKey: string } {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY is not set");
  return { url: url.replace(/\/$/, ""), apiKey };
}

async function readStepReach(
  scope: { orgId: string; brandId: string },
  query: Record<string, string>,
): Promise<unknown> {
  const { url, apiKey } = leadServiceBase();
  const params = new URLSearchParams(query);
  const path = `/internal/brands/${encodeURIComponent(scope.brandId)}/step-reached?${params}`;
  const res = await fetch(`${url}${path}`, {
    headers: { "x-api-key": apiKey, "x-org-id": scope.orgId },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const body = text.slice(0, 200);
    if (res.status === 400) {
      const code = (() => {
        try { return (JSON.parse(text) as { error?: unknown }).error; } catch { return null; }
      })();
      if (code === "step_not_observable" || code === "unknown_step") throw new StepNotObservableError(query.step, code);
    }
    throw new Error(`lead-service GET step-reached (${query.step}) failed: ${res.status}${body ? ` ${body}` : ""}`);
  }
  return res.json();
}

/**
 * Parse the people of a step-reached answer. Pure; throws on a malformed answer. `reachedAt` is always
 * dated in `since` mode; in `email` mode lead-service may answer null (every reach undated): such a
 * person still REACHED the step, so `allowUndated` keeps them (dated at the epoch, never used as an anchor).
 */
export function parseStepReachers(data: unknown, allowUndated = false): StepReacher[] {
  const people = (data as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) throw new Error("lead-service step-reached answered no people array");
  const out: StepReacher[] = [];
  for (const p of people as Array<Record<string, unknown>>) {
    const email = typeof p?.email === "string" ? p.email.trim().toLowerCase() : "";
    const reachedAt = typeof p?.reachedAt === "string"
      ? new Date(p.reachedAt)
      : allowUndated && p?.reachedAt === null ? new Date(0) : null;
    if (!email || !reachedAt || Number.isNaN(reachedAt.getTime())) {
      throw new Error(`lead-service step-reached answered a malformed person: ${JSON.stringify(p).slice(0, 200)}`);
    }
    out.push({
      email,
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : null,
      phone: typeof p.phone === "string" && p.phone.trim() ? p.phone.trim() : null,
      reachedAt,
    });
  }
  return out;
}

/** The people of (org, brand) who reached `step` at or after `since`. */
export async function fetchStepReachers(input: {
  orgId: string;
  brandId: string;
  step: string;
  since: Date;
}): Promise<StepReacher[]> {
  return parseStepReachers(await readStepReach(input, { step: input.step, since: input.since.toISOString() }));
}

/** Has this person EVER reached `step` at (org, brand)? */
export async function hasEverReachedStep(input: {
  orgId: string;
  brandId: string;
  step: string;
  email: string;
}): Promise<boolean> {
  const people = parseStepReachers(await readStepReach(input, { step: input.step, email: input.email.trim().toLowerCase() }), true);
  return people.some((p) => p.email === input.email.trim().toLowerCase());
}
