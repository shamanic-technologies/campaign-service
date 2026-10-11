/**
 * ON-DEMAND RUNS (owner 2026-10-11: "ça ne changera rien si le pipe a un trigger de type 'on demand' -> only exécuté
 * quand par ex le pipe cold email l'appelle").
 *
 * A pipe answering the `on_demand` trigger (features-service `channel-triggers.ts`; today the sourcing channels: an
 * origin or Lead Sourcing) is never dispatched by this service's scheduler (`answersInlineTrigger`): it runs WHEN
 * another pipe asks for it, inside that ask (lead-service serving the lead a cold email run needs, the same instant
 * as before). Each ask is still ITS OWN unit run, like every unit's: the performer asks this service to open it
 * (`POST /internal/on-demand-runs`), a ROOT run in runs-service with the shape `/start-run` gives a scheduled unit
 * run (`campaign-service` / task = the unit's campaign id) carrying the unit's campaign, brand, channel and workflow.
 * The performer does the work under it and closes it. So the pipe's costs are its own (own run id, own campaign,
 * own workflow), and when it runs does not move. The same door serves any future on-demand pipe.
 *
 * Refused, nothing opened: a campaign the org does not hold (404 `unknown_campaign`), a unit whose pipe does not
 * answer on demand (409 `not_on_demand`), a unit that is not ON (409 `campaign_off`), a unit with no brand (409
 * `no_brand`), a unit carrying no workflow (409 `no_workflow`: every pipe runs a workflow, owner 2026-10-11; a unit
 * takes its pipe's at launch, and the Lead Sourcing switch backfills an older one. This route reads no workflow
 * itself: only a person's start asks workflow-service, see tests/unit/no-legacy.test.ts).
 */
import { and, eq } from "drizzle-orm";
import { createRun } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { answersInlineTrigger } from "./source-campaigns.js";

export class OnDemandRunError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
    readonly reason: "unknown_campaign" | "not_on_demand" | "campaign_off" | "no_brand" | "no_workflow",
  ) {
    super(message);
    this.name = "OnDemandRunError";
  }
}

export interface OnDemandRunRequest {
  orgId: string;
  userId: string;
  /** The run of the pipe that asked (the cold email run): traced on the new run, never its parent. */
  callerRunId: string;
  /** The unit (campaign) of the pipe answering on demand. */
  campaignId: string;
  /** The audience the ask serves from, when the performer knows it: stamped like a scheduled run's. */
  audienceId?: string;
}

export interface OnDemandRun {
  runId: string;
  campaignId: string;
  featureSlug: string;
  workflowSlug: string;
  brandIds: string[];
}

export interface OnDemandRunDeps {
  createRun: typeof createRun;
}

const DEFAULT_DEPS: OnDemandRunDeps = { createRun };

/** Open one on-demand run of a unit (see the header). Throws `OnDemandRunError` on a refusal; anything else propagates. */
export async function openOnDemandRun(req: OnDemandRunRequest, deps: OnDemandRunDeps = DEFAULT_DEPS): Promise<OnDemandRun> {
  const campaign = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, req.campaignId), eq(campaigns.orgId, req.orgId)),
  });
  if (!campaign) throw new OnDemandRunError(`campaign ${req.campaignId} is not a campaign of org ${req.orgId}`, 404, "unknown_campaign");
  if (!campaign.featureSlug || !answersInlineTrigger(campaign.featureSlug)) {
    throw new OnDemandRunError(
      `campaign ${req.campaignId} runs channel ${campaign.featureSlug ?? "none"}, whose pipe does not answer on demand: the scheduler runs it`,
      409,
      "not_on_demand",
    );
  }
  if (campaign.status !== "ongoing") {
    throw new OnDemandRunError(`campaign ${req.campaignId} is ${campaign.status}: an off unit answers no ask`, 409, "campaign_off");
  }
  if (!campaign.brandIds || campaign.brandIds.length === 0) {
    throw new OnDemandRunError(`campaign ${req.campaignId} has no brand`, 409, "no_brand");
  }

  const workflowSlug = campaign.workflowSlug;
  if (!workflowSlug) {
    throw new OnDemandRunError(`campaign ${req.campaignId} (${campaign.featureSlug}) carries no workflow`, 409, "no_workflow");
  }

  const run = await deps.createRun({
    orgId: req.orgId,
    serviceName: "campaign-service",
    taskName: campaign.id,
    campaignId: campaign.id,
    brandId: campaign.brandIds.join(","),
    userId: req.userId,
    workflowSlug,
    featureSlug: campaign.featureSlug,
    audienceId: req.audienceId,
  });
  return { runId: run.id, campaignId: campaign.id, featureSlug: campaign.featureSlug, workflowSlug, brandIds: campaign.brandIds };
}
