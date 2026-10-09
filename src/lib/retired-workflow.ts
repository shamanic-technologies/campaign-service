import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { fetchLiveDynastyOtherThan } from "./startable-workflow-client.js";
import { isRetiredWorkflowRefusal } from "./workflow-refusal.js";

/**
 * A WORKFLOW THAT IS GONE IS NEVER ASKED FOR AGAIN.
 *
 * The stored `workflow_slug` is the selector's FALLBACK: it runs whenever nothing in the grid is
 * rankable (a brand with no return economics prices every cell at null). When workflow-service
 * deprecates that workflow it answers 410 and will answer 410 forever, so a campaign whose grid is
 * unrankable asked for the same dead slug on every tick and never ran. Prod 2026-10-09, campaign
 * 1e95a4c3: stored `sales-cold-email-outreach-rudder` (deprecated, no successor), 217 projection rows
 * all unpriced, ~130 stuck-sweep recoveries an hour, no run for 3 days.
 *
 * So a 410 is answered once, here: the successor workflow-service names, else the channel's newest
 * live dynasty other than the dead one. When the dead slug is the stored fallback, the row's
 * fallback is REPLACED (only `workflow_slug` moves; never a status: the customer's intent is
 * untouched), guarded on the dead value so a concurrent write is never overwritten. The caller
 * dispatches the successor in the same breath.
 *
 * Returns the successor, or null when the refusal is not a 410 or no live workflow can be named —
 * the caller then rethrows the original refusal into its own failure path (the scheduler's backoff
 * and staff alert), which is where "this channel has nothing to run" gets noticed.
 */
export async function replaceRetiredWorkflow(
  err: unknown,
  ctx: {
    campaignId: string;
    storedSlug: string | null;
    featureSlug: string;
    identity: { orgId: string; userId: string; runId: string; brandId?: string };
  },
): Promise<string | null> {
  if (!isRetiredWorkflowRefusal(err)) return null;
  const dead = err.workflowSlug;

  let successor = err.upgradedToWorkflowSlug;
  if (!successor) {
    const read = await fetchLiveDynastyOtherThan(ctx.featureSlug, dead, ctx.identity);
    if (!read.ok) {
      console.error(
        `[campaign-service] campaign ${ctx.campaignId}: workflow ${dead} is deprecated and the live ` +
          `workflows of ${ctx.featureSlug} could not be read (${read.detail}) — no successor this attempt`,
      );
      return null;
    }
    successor = read.workflowSlug;
  }
  if (!successor || successor === dead) {
    console.error(
      `[campaign-service] campaign ${ctx.campaignId}: workflow ${dead} is deprecated and ` +
        `${ctx.featureSlug} has NO other live workflow — nothing can run this campaign`,
    );
    return null;
  }

  if (ctx.storedSlug === dead) {
    await db
      .update(campaigns)
      .set({ workflowSlug: successor, updatedAt: new Date() })
      .where(and(eq(campaigns.id, ctx.campaignId), eq(campaigns.workflowSlug, dead)));
    // Once per campaign: the stored slug no longer names the dead workflow after this write.
    console.warn(
      `[campaign-service] campaign ${ctx.campaignId}: fallback workflow ${dead} is deprecated (410); ` +
        `replaced with ${successor}`,
    );
  } else {
    console.warn(
      `[campaign-service] campaign ${ctx.campaignId}: selected workflow ${dead} is deprecated (410); ` +
        `dispatching ${successor} instead`,
    );
  }
  return successor;
}
