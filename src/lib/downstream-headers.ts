export interface DownstreamIdentity {
  orgId: string;
  userId: string;
  runId: string;
  campaignId: string;
  brandId: string;
  /**
   * The DAG this campaign runs, when it runs one. NULL for a campaign whose channel the CUSTOMER
   * operates: the work happens off-platform, so there is no workflow to name and the header is
   * simply not sent rather than carrying an invented value.
   */
  workflowSlug: string | null;
  featureSlug: string;
}

export function buildServiceHeaders(apiKey: string, identity: DownstreamIdentity): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
    "x-brand-id": identity.brandId,
    "x-campaign-id": identity.campaignId,
    "x-feature-slug": identity.featureSlug,
  };
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;
  return headers;
}
