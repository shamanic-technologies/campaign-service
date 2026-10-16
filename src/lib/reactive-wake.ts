/**
 * A REACTIVE pipe runs only when there is work for it (owner 2026-10-16, WA-REACTIVE-LOOP-1016).
 *
 * A campaign whose (channel, leg) transition answers a trigger (features-service `stepTransitions[].mode ===
 * "reactive"` + `triggerId`) exists to answer people: someone who replied, filled a form, gave their WhatsApp number.
 * Two things give it work, and only these two:
 *   1. an OCCURRENCE of its trigger: dispatched by the trigger path (lib/trigger-events.ts / step-trigger.ts), never
 *      by this module;
 *   2. a person lead-service holds as OWED on a queue the pipe answers (its own, or the preceding leg's campaigns':
 *      a reply made due on the cold email campaign is answered by the meeting booking campaign), including a dated
 *      follow-up a previous run scheduled for later.
 * The scheduler's cadence therefore never runs a reactive campaign on a guess: when its turn comes, lead-service is
 * asked (no claim, no write) whether anyone is owed now; nobody = parked until the next owed moment it names, at most
 * `REACTIVE_RECHECK_MS` away. Why: prod 2026-10-15, a WhatsApp unit on `whatsapp_number_given` ran its workflow every
 * 10-15 s with nobody to greet (~19,000 empty runs a 3-day window across reactive pipes), and each empty run held the
 * one-run-per-campaign lock, so the occurrence it existed for was postponed six times and never served.
 *
 * A read that fails (lead-service or the predecessor lookup) RUNS the campaign as before and says so: the run's own
 * claim is the authority, and a person owed an answer is never left waiting on an outage (« jamais de non-followup »).
 * A catalogue that cannot be read names no reactive pipe: everything runs as before (the scheduler warns once).
 */
import type { ChannelCatalogueRead } from "./channel-operator-client.js";
import { sameLeg } from "./leg-identity.js";
import { resolvePredecessorCampaign } from "./predecessor-campaign.js";
import { fetchFollowupDue } from "./followup-due-client.js";

/** How long a reactive campaign nobody is owed on waits before lead-service is asked again. */
export const REACTIVE_RECHECK_MS = 10 * 60_000;

/** lead-service `POST /internal/followups/owed` `heldCampaignIds` max. */
const MAX_HELD_QUEUES = 20;

export interface ReactiveCampaign {
  id: string;
  orgId: string;
  featureSlug?: string | null;
  legKey?: string | null;
  runsOnTriggerId?: string | null;
}

/** True when the campaign's pipe answers a trigger (any), or the unit runs on its funnel's head trigger. Pure. */
export function answersATrigger(c: Omit<ReactiveCampaign, "id" | "orgId">, catalogue: ChannelCatalogueRead): boolean {
  if (c.runsOnTriggerId) return true;
  if (!catalogue.ok) return false;
  const slug = c.featureSlug ?? null;
  if (!slug || !c.legKey) return false;
  return (catalogue.triggerTransitions ?? []).some((t) => t.featureSlug === slug && sameLeg(slug, t.legKey, c.legKey));
}

export type ReactiveWake = { run: true } | { run: false; nextRunAt: Date };

/**
 * The queues this campaign answers: its own, then every campaign of the preceding leg (`predecessors[]`, the same
 * lookup the responder workflow claims on). An entry leg has none.
 */
async function heldCampaignIds(c: ReactiveCampaign, catalogue: ChannelCatalogueRead): Promise<string[]> {
  const outcome = await resolvePredecessorCampaign(c.id, catalogue);
  // lead-service reads at most 20 queues per acting campaign (its `heldCampaignIds` cap); its own comes first.
  return [...new Set([c.id, ...outcome.predecessors.map((p) => p.campaignId)])].slice(0, MAX_HELD_QUEUES);
}

/** Should this reactive campaign run now? Asks lead-service; never claims, never writes. */
export async function reactiveWake(
  c: ReactiveCampaign,
  catalogue: ChannelCatalogueRead,
  now: Date = new Date(),
): Promise<ReactiveWake> {
  try {
    const held = await heldCampaignIds(c, catalogue);
    const due = await fetchFollowupDue({ orgId: c.orgId, actingCampaignId: c.id, campaignIds: held });
    if (due.owedNow) return { run: true };
    const recheck = now.getTime() + REACTIVE_RECHECK_MS;
    const next = due.nextDueAt && due.nextDueAt.getTime() < recheck ? due.nextDueAt.getTime() : recheck;
    return { run: false, nextRunAt: new Date(Math.max(next, now.getTime() + 1_000)) };
  } catch (err) {
    console.error(
      `[campaign-service] reactive campaign ${c.id}: could not read who is owed (${err instanceof Error ? err.message : String(err)}); running it as before`,
    );
    return { run: true };
  }
}
