import { and, arrayContains, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, type Campaign } from "../db/schema.js";

export const SALES_OUTREACH_FEATURE_SLUG = "sales-cold-email-outreach";
export const SALES_CRM_FEATURE_SLUG = "sales-crm-email-outreach";
export const SALES_OUTREACH_WORKFLOW_SLUG = "sales-email-cold-outreach";

// The sales-outreach feature family. Both features share the SAME runtime behaviour in this
// service — brand-pause hold, brand-daily-budget pacing, greedy workflow rotation + Thompson
// audience selection, and the extend-audience lifecycle email. Any per-feature gate keyed on
// "is this a sales-outreach campaign?" MUST test membership here, not a single slug, so the two
// features stay byte-identical. (Adding a third sales feature = one line here.)
export const SALES_OUTREACH_FEATURE_SLUGS: ReadonlySet<string> = new Set([
  SALES_OUTREACH_FEATURE_SLUG,
  SALES_CRM_FEATURE_SLUG,
]);

export function isSalesOutreachFeature(slug?: string | null): boolean {
  return !!slug && SALES_OUTREACH_FEATURE_SLUGS.has(slug);
}

type CampaignStore = Pick<typeof db, "query" | "insert" | "update">;

export type EnsureSalesOutreachCampaignResult =
  | { action: "existing"; campaign: Campaign }
  | { action: "resumed"; campaign: Campaign }
  | { action: "created"; campaign: Campaign };

function defaultSalesOutreachCampaignName(brandId: string): string {
  return `Sales cold email outreach - ${brandId}`;
}

export async function ensureRunnableSalesOutreachCampaign(
  store: CampaignStore,
  {
    orgId,
    brandId,
    userId,
    runId,
    now = new Date(),
  }: {
    orgId: string;
    brandId: string;
    userId?: string;
    runId?: string;
    now?: Date;
  },
): Promise<EnsureSalesOutreachCampaignResult> {
  const existing = await store.query.campaigns.findFirst({
    where: and(
      eq(campaigns.orgId, orgId),
      eq(campaigns.status, "ongoing"),
      eq(campaigns.featureSlug, SALES_OUTREACH_FEATURE_SLUG),
      arrayContains(campaigns.brandIds, [brandId]),
    ),
    orderBy: [desc(campaigns.createdAt)],
  });

  if (existing) {
    return { action: "existing", campaign: existing };
  }

  const stopped = await store.query.campaigns.findFirst({
    where: and(
      eq(campaigns.orgId, orgId),
      eq(campaigns.status, "stopped"),
      eq(campaigns.featureSlug, SALES_OUTREACH_FEATURE_SLUG),
      arrayContains(campaigns.brandIds, [brandId]),
    ),
    orderBy: [desc(campaigns.updatedAt), desc(campaigns.createdAt)],
  });

  if (stopped) {
    if (!stopped.createdByUserId) {
      throw new Error(`Cannot resume sales outreach campaign ${stopped.id} - missing createdByUserId`);
    }

    const [campaign] = await store
      .update(campaigns)
      .set({ status: "ongoing", nextRunAt: now, updatedAt: now })
      .where(and(
        eq(campaigns.id, stopped.id),
        eq(campaigns.orgId, orgId),
        eq(campaigns.status, "stopped"),
      ))
      .returning();

    if (!campaign) {
      const concurrentExisting = await store.query.campaigns.findFirst({
        where: and(
          eq(campaigns.orgId, orgId),
          eq(campaigns.status, "ongoing"),
          eq(campaigns.featureSlug, SALES_OUTREACH_FEATURE_SLUG),
          arrayContains(campaigns.brandIds, [brandId]),
        ),
        orderBy: [desc(campaigns.createdAt)],
      });

      if (concurrentExisting) {
        return { action: "existing", campaign: concurrentExisting };
      }

      throw new Error(`Cannot resume sales outreach campaign ${stopped.id} - campaign was modified concurrently`);
    }

    return { action: "resumed", campaign };
  }

  if (!userId) {
    throw new Error("Cannot create sales outreach campaign while unpausing brand - x-user-id header required when no prior sales campaign exists");
  }

  const [created] = await store
    .insert(campaigns)
    .values({
      orgId,
      createdByUserId: userId,
      parentRunId: runId ?? null,
      name: defaultSalesOutreachCampaignName(brandId),
      workflowSlug: SALES_OUTREACH_WORKFLOW_SLUG,
      brandIds: [brandId],
      featureSlug: SALES_OUTREACH_FEATURE_SLUG,
      featureInputs: null,
      status: "ongoing",
      nextRunAt: now,
      updatedAt: now,
    })
    .returning();

  if (!created) {
    throw new Error(`Cannot create sales outreach campaign for brand ${brandId}`);
  }

  return { action: "created", campaign: created };
}
