/**
 * WHO DISPATCHES A PIPE: this service's scheduler, or another pipe asking for it (owner 2026-10-12, LEADS-ONLY).
 *
 * Owner rule (caps): "EVERY PIPE IS INDEPENDENT OF THE OTHERS". A sourcing pipe finds leads ON ITS OWN, inside its
 * funnel campaign's caps, never waiting for a later pipe to ask; each later pipe works what the pipe before it
 * produced. A leads-only funnel (Start -> Lead found -> Paid client by the customer's team) therefore finds leads
 * and contacts nobody.
 *
 * The catalogue is the switch, the same statement for every channel: a campaign whose (channel, leg) transition is
 * REACTIVE on the `on_demand` trigger (features-service `stepTransitions[].mode/triggerId`) runs only when another
 * pipe asks for it (lead-service serving the lead a cold email run needs, lib/on-demand-runs.ts): the scheduler
 * parks it. Any other reading is a campaign like every other: claimed when due, gate-checked, paced on its money.
 * features-service flips the sourcing legs from `on_demand` to proactive once every service is ready; nothing here
 * changes on that day.
 *
 * Two guards keep a source from running on a guess:
 *   - a SOURCE campaign runs on its own only on POSITIVE evidence: its channel publishes its leg and the transition is
 *     not `on_demand`. Unpublished, or a catalogue that cannot be read, answers on demand (today's behaviour).
 *   - a source campaign that is not a unit of a SALES FUNNEL campaign has no money of its own (pre-funnel sources are
 *     paced inside the outreach campaign they feed): it answers on demand whatever the catalogue says.
 * A campaign that is not a source answers on demand only when the catalogue says so; unreadable = it is not (today).
 */
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import { sameLeg } from "./leg-identity.js";
import { isSourceCampaign } from "./source-campaigns.js";

/** features-service's trigger a pipe answers when another pipe asks for it (`channel-triggers.ts` `inline`). */
export const ON_DEMAND_TRIGGER_ID = "on_demand";

/**
 * How long a claimed unit answering on demand is parked before it is looked at again: the moment features-service
 * reads its leg proactive, it starts within this.
 */
export const ON_DEMAND_RECHECK_MS = 10 * 60_000;

export interface DispatchModeCampaign {
  featureSlug?: string | null;
  legKey?: string | null;
  salesFunnelCampaignId?: string | null;
}

/** True when the campaign runs only when another pipe asks for it: the scheduler never dispatches it. */
export function answersOnDemand(c: DispatchModeCampaign, catalogue: ChannelCatalogueRead): boolean {
  const source = isSourceCampaign(c);
  if (!catalogue.ok) return source;
  if (source && !c.salesFunnelCampaignId) return true;
  const slug = c.featureSlug ?? null;
  if (!slug || !c.legKey) return source;
  const onDemand = (catalogue.triggerTransitions ?? []).some(
    (t) => t.featureSlug === slug && t.triggerId === ON_DEMAND_TRIGGER_ID && sameLeg(slug, t.legKey, c.legKey),
  );
  if (onDemand) return true;
  if (!source) return false;
  const published = catalogue.legsBySlug.get(slug);
  return !published || ![...published].some((leg) => sameLeg(slug, leg, c.legKey));
}

/** A SOURCE campaign this service dispatches on its own (it finds leads with nobody asking). */
export function sourceRunsOnItsOwn(c: DispatchModeCampaign, catalogue: ChannelCatalogueRead): boolean {
  return isSourceCampaign(c) && !answersOnDemand(c, catalogue);
}

/** The catalogue read every dispatch decision above is taken on (one seam, so tests can state the reading). */
export function readDispatchCatalogue(): Promise<ChannelCatalogueRead> {
  return fetchChannelCatalogue();
}
