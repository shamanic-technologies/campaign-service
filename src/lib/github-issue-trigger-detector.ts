import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, salesFunnelCampaigns, triggerEvents } from "../db/schema.js";
import type { ChannelCatalogueRead } from "./channel-operator-client.js";
import { GITHUB_ISSUE_RECORDED_VIA, detectableTriggers } from "./delay-trigger-detector.js";
import { checkGithubIssue, type GithubIssueReads } from "./github-issue-client.js";
import {
  GITHUB_ISSUE_IN_PROD_KIND,
  githubIssueFromKey,
  type GithubIssueCheck,
} from "./github-issue-trigger.js";
import { sameLeg } from "./leg-identity.js";
import { fireClaimedEvent } from "./trigger-events.js";

/**
 * THE `github_issue_in_prod` DETECTOR (lib/github-issue-trigger.ts), one pass of the generic detectors loop
 * (lib/trigger-detectors.ts, every 5 min).
 *
 * WHO WAITS: every ONGOING sales funnel campaign that states a `githubIssue` and owns a unit on a (channel, leg)
 * whose reactive transition names a trigger of this kind. Nothing else is read (no such trigger, or nobody
 * waiting = idle, no GitHub call).
 *
 * ONCE PER CAMPAIGN AND ISSUE, EVER: the event key is `github_issue:<trigger>:<funnel campaign>:<issue>`; a
 * campaign whose event exists is not checked again. Each issue is read once per pass, whoever waits on it.
 *
 * FIRE: the event is written BEFORE firing (never twice), then fired through the one door every event goes
 * through (`fireClaimedEvent`: same funding, people made due, same `/execute`), restricted to THAT funnel
 * campaign's units; the issue rides `/execute` as `trigger.item`. A throw puts it back `pending` on the 10-min
 * retry, fired by the scheduler's due-event tick.
 *
 * FAIL LOUD: an unreadable source (GitHub, the box record) or a repo the box never serves is one error line per
 * issue per pass, and the verdict is stored on each waiting campaign (`github_issue_check`), never "not yet".
 */

export interface GithubIssueTickSummary {
  triggers: number;
  /** Funnel campaigns waiting on an issue (not fired yet). */
  waiting: number;
  /** Distinct issues read this pass. */
  checked: number;
  fired: number;
  /** Issues whose verdict could not be read (GitHub, the box record) or can never fire (repo not on the box). */
  failed: number;
}

const FAILED_STATES: ReadonlySet<GithubIssueCheck["state"]> = new Set(["github_unreadable", "served_unreadable", "not_served_by_box"]);

export function githubIssueIdempotencyKey(triggerId: string, salesFunnelCampaignId: string, issueKey: string): string {
  return `github_issue:${triggerId}:${salesFunnelCampaignId}:${issueKey}`;
}

interface Waiter {
  salesFunnelCampaignId: string;
  orgId: string;
  brandId: string;
  offerId: string;
  issueKey: string;
  triggerId: string;
}

export async function detectGithubIssueTriggers(
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
  now: Date,
  reads?: GithubIssueReads,
): Promise<GithubIssueTickSummary> {
  const summary: GithubIssueTickSummary = { triggers: 0, waiting: 0, checked: 0, fired: 0, failed: 0 };
  const triggers = detectableTriggers(catalogue, GITHUB_ISSUE_IN_PROD_KIND, () => ({ ok: true, params: null }));
  summary.triggers = triggers.length;
  if (triggers.length === 0) return summary;

  const slugs = [...new Set(triggers.flatMap((t) => t.transitions.map((x) => x.featureSlug)))];
  const units = await db
    .select({
      featureSlug: campaigns.featureSlug,
      legKey: campaigns.legKey,
      salesFunnelCampaignId: salesFunnelCampaigns.id,
      orgId: salesFunnelCampaigns.orgId,
      brandId: salesFunnelCampaigns.brandId,
      offerId: salesFunnelCampaigns.offerId,
      githubIssue: salesFunnelCampaigns.githubIssue,
    })
    .from(campaigns)
    .innerJoin(salesFunnelCampaigns, eq(campaigns.salesFunnelCampaignId, salesFunnelCampaigns.id))
    .where(and(
      eq(campaigns.status, "ongoing"),
      eq(salesFunnelCampaigns.status, "ongoing"),
      isNotNull(salesFunnelCampaigns.githubIssue),
      isNotNull(campaigns.legKey),
      inArray(campaigns.featureSlug, slugs),
    ));

  const waiters = new Map<string, Waiter>();
  for (const u of units) {
    if (!u.featureSlug || !u.legKey || !u.githubIssue || !githubIssueFromKey(u.githubIssue)) continue;
    for (const t of triggers) {
      if (!t.transitions.some((x) => x.featureSlug === u.featureSlug && sameLeg(u.featureSlug!, x.legKey, u.legKey))) continue;
      const key = githubIssueIdempotencyKey(t.type.id, u.salesFunnelCampaignId, u.githubIssue);
      waiters.set(key, {
        salesFunnelCampaignId: u.salesFunnelCampaignId,
        orgId: u.orgId,
        brandId: u.brandId,
        offerId: u.offerId,
        issueKey: u.githubIssue,
        triggerId: t.type.id,
      });
    }
  }
  if (waiters.size === 0) return summary;

  const done = await db
    .select({ key: triggerEvents.idempotencyKey })
    .from(triggerEvents)
    .where(inArray(triggerEvents.idempotencyKey, [...waiters.keys()]));
  for (const d of done) if (d.key) waiters.delete(d.key);
  summary.waiting = new Set([...waiters.values()].map((w) => w.salesFunnelCampaignId)).size;
  if (waiters.size === 0) return summary;

  const checks = new Map<string, GithubIssueCheck>();
  for (const issueKey of new Set([...waiters.values()].map((w) => w.issueKey))) {
    const check = await checkGithubIssue(githubIssueFromKey(issueKey)!, now, reads);
    checks.set(issueKey, check);
    summary.checked += 1;
    if (FAILED_STATES.has(check.state)) {
      summary.failed += 1;
      console.error(`[campaign-service] GitHub issue ${issueKey} cannot be told in prod (${check.state}): ${check.detail}`);
    }
  }

  const checkedCampaigns = new Set<string>();
  for (const [key, w] of waiters) {
    const check = checks.get(w.issueKey)!;
    if (!checkedCampaigns.has(w.salesFunnelCampaignId)) {
      checkedCampaigns.add(w.salesFunnelCampaignId);
      await db
        .update(salesFunnelCampaigns)
        .set({ githubIssueCheck: check })
        .where(eq(salesFunnelCampaigns.id, w.salesFunnelCampaignId));
    }
    if (check.state !== "in_prod") continue;

    const item = { githubIssue: w.issueKey, mergeSha: check.mergeSha, mergedBy: check.mergedBy, served: check.served };
    const [event] = await db.insert(triggerEvents).values({
      orgId: w.orgId,
      brandId: w.brandId,
      offerId: w.offerId,
      triggerId: w.triggerId,
      idempotencyKey: key,
      recordedVia: GITHUB_ISSUE_RECORDED_VIA,
      occurredAt: now,
      dueAt: now,
      status: "firing",
      claimedAt: now,
      attempts: 1,
      detail: { salesFunnelCampaignId: w.salesFunnelCampaignId, item },
    }).onConflictDoNothing().returning();
    // Lost a race to another pass: that pass fires it.
    if (!event) continue;
    const fired = await fireClaimedEvent(event, catalogue, now, { item });
    console.log(
      `[campaign-service] GitHub issue ${w.issueKey} in prod: event ${event.id} for sales funnel campaign ${w.salesFunnelCampaignId} -> ${fired.outcome ?? fired.status}${fired.skipReason ? ` (${fired.skipReason})` : ""}`,
    );
    summary.fired += 1;
  }
  return summary;
}
