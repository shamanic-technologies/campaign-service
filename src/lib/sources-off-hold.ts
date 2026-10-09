import { fetchChannelCatalogue } from "./channel-operator-client.js";
import { legIsReactive } from "./leg-identity.js";
import { sourceCampaignsFeeding } from "./source-campaign-store.js";
import { isSourcedChannel } from "./source-campaigns.js";

/** How long an outreach campaign whose every source is OFF waits before it is looked at again. */
export const SOURCES_OFF_RECHECK_MS = 10 * 60_000;

/**
 * AN OUTREACH CAMPAIGN WHOSE EVERY SOURCE IS OFF HAS NOTHING TO SERVE: it is held, not run.
 *
 * lead-service refuses a serve (`source_campaign_off`) when the offer's lead sources are campaigns
 * and the audience's origin is not ON ("nothing is bought from a source the customer did not turn
 * on"). When EVERY source of the offer is off, every serve is refused, so every run of the
 * outreach campaign is a no-op — and the DAG reports each refusal as `stopCampaign`, which marks the
 * served audience exhausted. Prod 2026-10-09, campaign 1e95a4c3 (its only source born OFF by the 10-07
 * mirror, since fixed: lib/source-campaign-store.ts `ensureSourcesOnStart`): one run every ~11s, one audience falsely marked exhausted per run, heading for the
 * all-exhausted path (paid audience refill + a "fully contacted" client email) in about two minutes.
 *
 * The question is answered from the SAME read lead-service's refusal is built on
 * (`sourceCampaignsFeeding`, served as `GET /internal/campaigns/:id/source-campaigns`): the offer has
 * source campaigns, and none is `ongoing`. No source row at all = the legacy serve, never held.
 *
 * A REACTIVE leg is never held (it works people already found, from lead-service's follow-up queue),
 * so the catalogue is asked — only when the hold would otherwise apply, which is rare. An unreadable
 * catalogue holds nothing: the run goes ahead as it did before this existed.
 *
 * Never a status change: the customer turned the SOURCE off, not this campaign; turning one back on
 * is picked up on the next recheck.
 */
export async function sourcesOffHold(campaign: {
  id: string;
  featureSlug: string;
  legKey: string | null;
}): Promise<{ sourceCampaignIds: string[] } | null> {
  if (!isSourcedChannel(campaign.featureSlug)) return null;
  const sources = await sourceCampaignsFeeding(campaign.id, campaign.featureSlug);
  if (sources.length === 0 || sources.some((s) => s.status === "ongoing")) return null;

  const catalogue = await fetchChannelCatalogue();
  if (!catalogue.ok) {
    console.warn(
      `[campaign-service] campaign ${campaign.id}: every source of its offer is OFF, but the channel catalogue ` +
        `could not be read (${catalogue.detail}) to tell whether its leg is reactive — not held this tick`,
    );
    return null;
  }
  if (legIsReactive(catalogue, campaign.featureSlug, campaign.legKey) === true) return null;

  return { sourceCampaignIds: sources.map((s) => s.id) };
}
