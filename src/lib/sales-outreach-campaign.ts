import { and, arrayContains, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, type Campaign } from "../db/schema.js";
import { campaignIdentityColumns } from "./campaign-identity.js";

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

function defaultSalesOutreachCampaignName(featureSlug: string, brandId: string): string {
  const label = featureSlug === SALES_CRM_FEATURE_SLUG ? "Sales CRM email outreach" : "Sales cold email outreach";
  return `${label} - ${brandId}`;
}

// The workflow slug stamped on a freshly-seeded campaign. It is ONLY a fallback: the scheduler
// re-resolves the workflow via features-service (greedy /workflow-projection) on the campaign's
// FIRST tick (rotation is enabled for every sales-outreach feature), so this literal is
// overridden before it is ever executed. We therefore do NOT hardcode cold's workflow for every
// feature — cold keeps its historical seed slug; any other sales-outreach feature stamps its own
// feature slug as a harmless nominal (features-service picks the real dynasty at trigger).
function seedWorkflowSlugForFeature(featureSlug: string): string {
  return featureSlug === SALES_OUTREACH_FEATURE_SLUG ? SALES_OUTREACH_WORKFLOW_SLUG : featureSlug;
}

export async function ensureRunnableSalesOutreachCampaign(
  store: CampaignStore,
  {
    orgId,
    brandId,
    userId,
    runId,
    featureSlug,
    now = new Date(),
  }: {
    orgId: string;
    brandId: string;
    userId?: string;
    runId?: string;
    // The sales-outreach feature to (re)seed for this brand. On un-pause the caller forwards the
    // resumed product's x-feature-slug; campaign-service must NOT hardcode cold. Defaults to
    // sales-cold-email-outreach when absent (brand-level dashboard un-pause carries no feature) or
    // when a non-sales slug is passed (pause is a sales-outreach switch).
    featureSlug?: string;
    now?: Date;
  },
): Promise<EnsureSalesOutreachCampaignResult> {
  const resolvedFeatureSlug = isSalesOutreachFeature(featureSlug)
    ? (featureSlug as string)
    : SALES_OUTREACH_FEATURE_SLUG;

  const existing = await store.query.campaigns.findFirst({
    where: and(
      eq(campaigns.orgId, orgId),
      eq(campaigns.status, "ongoing"),
      eq(campaigns.featureSlug, resolvedFeatureSlug),
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
      eq(campaigns.featureSlug, resolvedFeatureSlug),
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
      // Clearing stopReason keeps the column describing the CURRENT state: the stop it described
      // is over, and an ongoing campaign must never look like a resume candidate.
      .set({ status: "ongoing", stopReason: null, nextRunAt: now, updatedAt: now })
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
          eq(campaigns.featureSlug, resolvedFeatureSlug),
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
      name: defaultSalesOutreachCampaignName(resolvedFeatureSlug, brandId),
      workflowSlug: seedWorkflowSlugForFeature(resolvedFeatureSlug),
      brandIds: [brandId],
      ...campaignIdentityColumns({ brandIds: [brandId], featureSlug: resolvedFeatureSlug }),
      featureSlug: resolvedFeatureSlug,
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
