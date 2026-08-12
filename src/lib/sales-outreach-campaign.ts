import { and, arrayContains, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, type Campaign } from "../db/schema.js";

export const SALES_OUTREACH_FEATURE_SLUG = "sales-cold-email-outreach";
export const SALES_CRM_FEATURE_SLUG = "sales-crm-email-outreach";

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

type CampaignStore = Pick<typeof db, "query" | "update">;

export type EnsureSalesOutreachCampaignResult =
  | { action: "existing"; campaign: Campaign }
  | { action: "resumed"; campaign: Campaign }
  // No sales campaign has ever existed for this brand, so there is nothing to resume and nothing
  // here can state which funnel a new one would sell. Provisioning is left to the scheduler's
  // per-funnel step, which knows the answer: it stands up one campaign per funnel the customer
  // FUNDS and brand-service DECLARES, each stating its own funnel.
  | { action: "deferred" };

export async function ensureRunnableSalesOutreachCampaign(
  store: CampaignStore,
  {
    orgId,
    brandId,
    featureSlug,
    now = new Date(),
  }: {
    orgId: string;
    brandId: string;
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

  // A campaign is never born without stating the funnel it sells, and un-pause has no way to
  // know that funnel: reading the brand's declared set here would be an inference (and an HTTP
  // read inside this transaction). The scheduler's funnel provisioner creates one campaign per
  // funded, declared funnel on the next tick — with its funnel stated.
  return { action: "deferred" };
}
