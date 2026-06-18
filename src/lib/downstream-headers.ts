export interface DownstreamIdentity {
  orgId: string;
  userId: string;
  runId: string;
  campaignId: string;
  brandId: string;
  workflowSlug: string;
  featureSlug: string;
}

export function buildServiceHeaders(apiKey: string, identity: DownstreamIdentity): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
    "x-brand-id": identity.brandId,
    "x-campaign-id": identity.campaignId,
    "x-workflow-slug": identity.workflowSlug,
    "x-feature-slug": identity.featureSlug,
  };
}
