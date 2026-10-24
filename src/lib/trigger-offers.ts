import { fetchChannelCatalogue } from "./channel-operator-client.js";
import { compositesListing } from "./composite-trigger.js";
import { liveScopesBehind } from "./delay-trigger-detector.js";
import { TriggerEventError } from "./trigger-events.js";
import { resolveTriggerType } from "./trigger-aliases.js";

/**
 * WHICH OFFERS OF A BRAND AN OCCURRENCE OF A TRIGGER WOULD RUN (OFFER-FROM-LIVE-CAMPAIGNS-1024, owner 2026-10-24: every
 * new event of a lead's own action reaches our reactive leads campaign, which decides to write, wait or do nothing).
 *
 * Every occurrence names one offer (`POST /internal/trigger-events`), and a caller that knows the person but not
 * the offer (an inbound visitor is in no campaign; the brand sells 2+ offers) used to give up. The answer belongs
 * here, beside the dispatch: the offers with an ONGOING campaign answering the trigger, directly or through a
 * trigger made of it (`lead_event`, lib/composite-trigger.ts), the same predicate the detectors watch
 * (`liveScopesBehind`). Generic: no trigger id, channel or brand named here.
 *
 * THROWS `TriggerEventError`: 502 when the catalogue cannot be read, 400 `unknown_trigger` when it declares no such
 * trigger. An empty list is a real answer: nothing live would run it.
 */
export async function liveOffersAnsweringTrigger(input: { orgId: string; brandId: string; triggerId: string }): Promise<{ triggerId: string; offerIds: string[] }> {
  const catalogue = await fetchChannelCatalogue();
  if (!catalogue.ok) {
    throw new TriggerEventError(`the acquisition-channel catalogue could not be read: ${catalogue.detail}`, 502, "catalogue_unavailable");
  }
  const type = resolveTriggerType(catalogue, input.triggerId);
  if (!type) {
    throw new TriggerEventError(`trigger ${JSON.stringify(input.triggerId)} is not a trigger type features-service declares`, 400, "unknown_trigger");
  }
  const transitionsOf = (id: string) => (catalogue.triggerTransitions ?? []).filter((t) => t.triggerId === id);
  const composites = compositesListing(catalogue, type.id).map((c) => ({ type: { id: c.id }, transitions: transitionsOf(c.id) }));
  const scopes = await liveScopesBehind({ type: { id: type.id }, transitions: transitionsOf(type.id), composites });
  const offerIds = [...new Set(scopes.filter((s) => s.orgId === input.orgId && s.brandId === input.brandId).map((s) => s.offerId))].sort();
  return { triggerId: type.id, offerIds };
}
