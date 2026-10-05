import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { campaigns } from "../db/schema.js";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import type { DbTransaction } from "./campaign-status-history.js";

/**
 * ONE PROACTIVE CAMPAIGN ON PER OFFER (owner, 2026-10-05).
 *
 * A PROACTIVE campaign works an ENTRY leg (a leg features-service publishes with no step before
 * it): it goes and finds people and spends a daily budget. An offer's plan money buys ONE of them
 * at a time. So when a PERSON turns a proactive campaign ON, the offer's other ON proactive
 * campaign is stopped in the same transaction, as that same person's act: its stop reason is
 * `manual` (the person's statement, lib/stop-reason.ts) and its transition source is
 * `proactive_switch`, so the ledger says why. Billing hears the stop like any person's move and
 * moves the plan money to the new one.
 *
 * NOTHING ELSE SWITCHES IT. No tick, no ROI, no AI calls this: only the three person start paths
 * (POST /campaigns, POST /campaigns/start-funded-pair, PATCH status=activate). The campaign
 * picked at signup stays until a person picks another. Offers that already hold two proactive
 * campaigns ON are left exactly as they are until a person starts one of them.
 *
 * REACTIVE campaigns (a leg out of a step a lead reached) are never stopped here.
 *
 * Which legs are entry legs is ASKED of the public catalogue (`fromStep` null), the same read
 * `/recurring-status` and `/predecessor` answer from. It is asked ONLY when the offer holds another
 * live campaign: an offer with nothing else on reads nothing and changes nothing. An unreadable
 * catalogue while another campaign is live REFUSES the start (502, rolled back): the rule cannot be
 * kept blind, and starting anyway could leave two proactive campaigns spending one plan.
 */

export const PROACTIVE_SWITCH_LOCK_PREFIX = "single-proactive";

/** What the start answer says about each campaign it turned off. */
export interface StoppedCampaign {
  id: string;
  name: string;
  featureSlug: string | null;
  offerId: string | null;
  legKey: string | null;
}

export class ProactiveCatalogueUnavailableError extends Error {
  readonly status = 502;
  readonly reason = "catalogue_unavailable";
  readonly customerMessage =
    "We couldn't check which of this offer's campaigns finds new people just now. Please try again in a minute.";
}

type CampaignRow = typeof campaigns.$inferSelect;

/** The campaign a person just turned ON, as the transaction sees it. */
export interface KeptCampaign {
  id: string;
  orgId: string;
  offerId: string | null;
  legKey: string | null;
}

/** True ⟺ the catalogue publishes this leg AND it starts from nothing. Unknown leg = false. */
export function isEntryLeg(catalogue: Extract<ChannelCatalogueRead, { ok: true }>, legKey: string): boolean {
  const leg = catalogue.legs.find((l) => l.legKey === legKey);
  return leg !== undefined && leg.fromStepKey === null;
}

/**
 * The offer's OTHER live proactive campaigns, to be stopped because `kept` was just turned on.
 *
 * Runs inside the start's transaction and serializes every start on one (org, offer) behind a
 * transaction-scoped advisory lock, so two people (or two tabs) starting two proactive campaigns
 * at once end with exactly one ON: the second waits, then sees the first as live and stops it.
 *
 * Returns [] (and reads nothing) when the kept campaign states no offer or leg, or when nothing
 * else on the offer is live. Throws `ProactiveCatalogueUnavailableError` when the catalogue is
 * needed and cannot be read.
 */
export async function proactiveCampaignsToStop(
  tx: DbTransaction,
  kept: KeptCampaign,
  deps: { catalogue?: () => Promise<ChannelCatalogueRead> } = {},
): Promise<CampaignRow[]> {
  if (!kept.offerId || !kept.legKey) return [];

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${PROACTIVE_SWITCH_LOCK_PREFIX}:${kept.orgId}:${kept.offerId}`}))`,
  );

  const live = await tx
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.orgId, kept.orgId),
        eq(campaigns.offerId, kept.offerId),
        eq(campaigns.status, "ongoing"),
        ne(campaigns.id, kept.id),
        isNotNull(campaigns.legKey),
      ),
    );
  if (live.length === 0) return [];

  const catalogue = await (deps.catalogue ?? fetchChannelCatalogue)();
  if (!catalogue.ok) {
    throw new ProactiveCatalogueUnavailableError(
      `the acquisition-channel catalogue could not be read (${catalogue.detail}), so whether campaign ${kept.id} replaces another proactive campaign of offer ${kept.offerId} cannot be said`,
    );
  }
  if (!isEntryLeg(catalogue, kept.legKey)) {
    // A reactive campaign (or a leg the catalogue no longer publishes) displaces nothing.
    return [];
  }
  return live.filter((c) => isEntryLeg(catalogue, c.legKey!));
}

export function stoppedCampaignSummary(c: CampaignRow): StoppedCampaign {
  return { id: c.id, name: c.name, featureSlug: c.featureSlug, offerId: c.offerId, legKey: c.legKey };
}
