import type { IdentityHeaders } from "@distribute/runs-client";
import { ensureCampaignRunId, type AnchorableCampaign } from "./trigger-run.js";

/**
 * The identity the PROVISIONING path carries — well-formed enough for a sibling to accept it.
 *
 * Provisioning asks two services what a funded pair may do: features-service which funnels a
 * channel sells (`GET /features/{slug}`) and workflow-service which workflow can run it
 * (`GET /workflows?featureSlug=`). Both REJECT a request that does not state a full identity —
 * `400 Missing required headers: x-run-id` and `400 x-org-id, x-user-id, and x-run-id headers are
 * required` — whatever the caller happens to be doing.
 *
 * The provisioning identity was built from a CAMPAIGN ROW, which carries no run, so both reads
 * 400'd on every sweep and both rejections were laundered into "unknown" and skipped. The whole
 * per-channel funding promise therefore never worked once in production: brand 75d7e3e8 funded the
 * feedback-request channel on 2026-08-19 and had no campaign for it nineteen hours later, with not
 * one line in the logs about any of it. The brand-service read on the same path answers 200 without
 * a run id, which is why only this half was dead and why it looked like nothing at all.
 *
 * So the identity STATES a run id, and it is a run that EXISTS: the campaign's own ancestor via
 * `ensureCampaignRunId`, created once and persisted on the row. Never a minted uuid — a run id this
 * service hands another service must be one runs-service can resolve (see trigger-run.ts), and
 * `tests/unit/no-legacy.test.ts` fails on a minted uuid here.
 *
 * `userId` and `runId` are REQUIRED by the type rather than filled in when convenient: both clients
 * used to attach their headers only when they happened to have them, which is exactly how a
 * silently-identity-less read survives a refactor.
 */
export interface ProvisioningIdentity extends IdentityHeaders {
  userId: string;
  runId: string;
}

/**
 * Establish the identity provisioning reads with, or say why it could not be.
 *
 * Fail-SOFT: a campaign with no owner to attribute a new campaign to, or an anchor runs-service
 * would not create, provisions nothing this sweep and is looked at again on the next one. It does
 * NOT hold the brand — this decides which questions can be asked, not whether money may be spent,
 * and the turn-taking and the funding hold are deliberately untouched by it.
 */
export async function buildProvisioningIdentity(
  seed: AnchorableCampaign & { workflowSlug?: string | null },
  brandId: string,
): Promise<ProvisioningIdentity | null> {
  if (!seed.createdByUserId) return null;

  let runId: string;
  try {
    runId = await ensureCampaignRunId(seed);
  } catch (err) {
    console.warn(
      `[campaign-service] Not provisioning funded funnels of brand ${brandId} (org ${seed.orgId}) this sweep — the ancestor run its reads must state could not be established:`,
      err,
    );
    return null;
  }

  return {
    orgId: seed.orgId,
    userId: seed.createdByUserId,
    runId,
    campaignId: seed.id,
    brandId,
    workflowSlug: seed.workflowSlug ?? undefined,
    featureSlug: seed.featureSlug ?? undefined,
  };
}
