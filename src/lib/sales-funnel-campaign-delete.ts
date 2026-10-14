import { and, eq, inArray } from "drizzle-orm";
import { listRuns } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns, salesFunnelCampaigns, triggerEventDeliveries, type SalesFunnelCampaign } from "../db/schema.js";

/**
 * DELETE a sales funnel campaign created by mistake (owner 2026-10-14: a client or its AI agent creates
 * one STOPPED to review it, then finds it is the wrong funnel, a test or a duplicate).
 *
 * Only a campaign that NEVER RAN can go. A campaign that ran once (spent, sent, has any outcome) keeps
 * its history: it lives in the dashboard's Past tab and its stats are never lost, so it is refused with
 * a named reason. "Ran" is a POSITIVE fact read from runs-service: any run filed under one of its units
 * (any status: a failed run may have spent), or any trigger delivery we recorded for one of them.
 * runs-service unreadable = refused (502), never deleted on a guess.
 *
 * What goes: the funnel campaign row and its unit rows, in ONE transaction, re-checked under a row lock
 * (a start racing the delete wins). The status transitions stay (append-only history, never rewritten,
 * same as DELETE /campaigns/:id). Billing's OWN caps for this funnel campaign are cleared first (its
 * DELETE .../campaigns/:salesFunnelCampaignId/caps); the funnel-WIDE cap is shared by every campaign on
 * that funnel and is never touched. features-service is told to recompute the brand's Campaigns rows.
 */

export const SALES_FUNNEL_DELETE_REFUSALS = {
  ONGOING: "sales_funnel_campaign_ongoing",
  HAS_HISTORY: "sales_funnel_campaign_has_history",
  RUNS_UNAVAILABLE: "runs_unavailable",
  BILLING_UNAVAILABLE: "billing_unavailable",
} as const;

export interface DeleteRefusal {
  status: 409 | 502;
  body: { error: string; reason: string; detail?: string };
}

type CampaignRow = typeof campaigns.$inferSelect;

/** Customer-facing English the dashboard and the MCP render verbatim. */
const ONGOING_REFUSAL: DeleteRefusal = {
  status: 409,
  body: {
    error: "This campaign is running. Stop it first, then delete it.",
    reason: SALES_FUNNEL_DELETE_REFUSALS.ONGOING,
  },
};

const HISTORY_REFUSAL: DeleteRefusal = {
  status: 409,
  body: {
    error: "This campaign has already run, so its results are kept. Stop it instead: it stays in your past campaigns.",
    reason: SALES_FUNNEL_DELETE_REFUSALS.HAS_HISTORY,
  },
};

export function ongoingRefusal(parent: SalesFunnelCampaign, units: CampaignRow[]): DeleteRefusal | null {
  if (parent.status === "ongoing" || units.some((u) => u.status === "ongoing")) return ONGOING_REFUSAL;
  return null;
}

/** Did any unit ever run? Positive evidence only; throws when runs-service cannot answer. */
export async function salesFunnelCampaignEverRan(orgId: string, unitIds: string[]): Promise<boolean> {
  if (unitIds.length === 0) return false;
  const delivered = await db
    .select({ id: triggerEventDeliveries.id })
    .from(triggerEventDeliveries)
    .where(inArray(triggerEventDeliveries.campaignId, unitIds))
    .limit(1);
  if (delivered.length > 0) return true;
  // Any status on purpose: a failed run may have spent. Bounded: these ids only, one row.
  const { runs } = await listRuns({ orgId, campaignIds: unitIds, limit: 1 });
  return runs.length > 0;
}

/** billing-service: clear THIS funnel campaign's own caps (the funnel-wide cap is never touched). */
async function clearOwnBillingCaps(parent: SalesFunnelCampaign, userId?: string, runId?: string): Promise<void> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  const headers: Record<string, string> = { "x-api-key": apiKey, "x-org-id": parent.orgId };
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;
  const res = await fetch(
    `${url.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(parent.brandId)}/offers/${encodeURIComponent(parent.offerId)}` +
      `/sales-funnels/${encodeURIComponent(parent.salesFunnelId)}/campaigns/${encodeURIComponent(parent.id)}/caps`,
    { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`billing-service refused to clear the caps of sales funnel campaign ${parent.id}: ${res.status} ${await res.text()}`);
  }
}

export type DeleteOutcome =
  | { deleted: true; unitIds: string[] }
  | { deleted: false; refusal: DeleteRefusal }
  | { deleted: false; notFound: true };

export async function deleteSalesFunnelCampaign(args: {
  parent: SalesFunnelCampaign;
  units: CampaignRow[];
  userId?: string;
  runId?: string;
}): Promise<DeleteOutcome> {
  const { parent, units } = args;
  const ongoing = ongoingRefusal(parent, units);
  if (ongoing) return { deleted: false, refusal: ongoing };

  const unitIds = units.map((u) => u.id);
  let ran: boolean;
  try {
    ran = await salesFunnelCampaignEverRan(parent.orgId, unitIds);
  } catch (err) {
    console.error(`[campaign-service] cannot tell whether sales funnel campaign ${parent.id} ever ran:`, err);
    return {
      deleted: false,
      refusal: {
        status: 502,
        body: {
          error: "We could not check this campaign's history. Nothing was deleted, try again in a minute.",
          reason: SALES_FUNNEL_DELETE_REFUSALS.RUNS_UNAVAILABLE,
          detail: err instanceof Error ? err.message : String(err),
        },
      },
    };
  }
  if (ran) return { deleted: false, refusal: HISTORY_REFUSAL };

  try {
    await clearOwnBillingCaps(parent, args.userId, args.runId);
  } catch (err) {
    console.error(`[campaign-service] sales funnel campaign ${parent.id} not deleted, billing caps not cleared:`, err);
    return {
      deleted: false,
      refusal: {
        status: 502,
        body: {
          error: "We could not clear this campaign's budget. Nothing was deleted, try again in a minute.",
          reason: SALES_FUNNEL_DELETE_REFUSALS.BILLING_UNAVAILABLE,
          detail: err instanceof Error ? err.message : String(err),
        },
      },
    };
  }

  return db.transaction(async (tx): Promise<DeleteOutcome> => {
    const [locked] = await tx
      .select()
      .from(salesFunnelCampaigns)
      .where(and(eq(salesFunnelCampaigns.id, parent.id), eq(salesFunnelCampaigns.orgId, parent.orgId)))
      .for("update");
    if (!locked) return { deleted: false, notFound: true };
    const lockedUnits = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.orgId, parent.orgId), eq(campaigns.salesFunnelCampaignId, parent.id)))
      .for("update");
    const startedMeanwhile = ongoingRefusal(locked, lockedUnits);
    if (startedMeanwhile) return { deleted: false, refusal: startedMeanwhile };
    const lockedIds = lockedUnits.map((u) => u.id);
    // A unit born between the history read and the lock was never asked about: ask now (throws = rolled back).
    const bornMeanwhile = lockedIds.filter((id) => !unitIds.includes(id));
    if (await salesFunnelCampaignEverRan(parent.orgId, bornMeanwhile)) return { deleted: false, refusal: HISTORY_REFUSAL };

    if (lockedIds.length > 0) {
      await tx.delete(campaigns).where(and(eq(campaigns.orgId, parent.orgId), inArray(campaigns.id, lockedIds)));
    }
    await tx
      .delete(salesFunnelCampaigns)
      .where(and(eq(salesFunnelCampaigns.id, parent.id), eq(salesFunnelCampaigns.orgId, parent.orgId)));
    return { deleted: true, unitIds: lockedIds };
  });
}
