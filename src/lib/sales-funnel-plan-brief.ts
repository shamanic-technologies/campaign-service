import type { Campaign, SalesFunnelCampaign } from "../db/schema.js";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import { judgeUnderCampaignRun } from "./channel-down-replay.js";
import type { NoulQuestion } from "./jev-client.js";

/**
 * A PLAN NEVER DRAINS A CHANNEL THE BRIEF NAMES (PLAN-SWITCH-OFF-1029, owner 2026-10-29).
 *
 * Prod 2026-10-29: Definitejobs' brief says "Use only these channels: Use Email Sending … Use AI Meeting Booking …";
 * features-service's plan left AI Meeting Booking out, so following it drained that unit and the client stopped
 * booking meetings from new positive replies. features-service owns the plan (its planner is being fixed); this is the
 * BACKSTOP: before a plan change drains a running unit, Jev is asked once per channel whether the campaign's brief
 * explicitly tells us to use that channel. Yes = the unit is kept running as it is (never drained), the rest of the
 * plan applies, and the check is red `plan_contradicts_brief` naming the plan's id. Asked only when a plan change would
 * drain a running unit of a campaign that states a brief (rare: a plan change), never on a quiet pass.
 *
 * Whose work: the judgment decides whether that unit keeps taking people, so it is that unit's production: one run of
 * its own tree (`campaign-service / plan-brief-channel-judgment`, lib/channel-down-replay.ts `judgeUnderCampaignRun`).
 * Jev or the catalogue unreachable = nothing applied, red (never a guess).
 */

/** Jev's P(the brief names this channel) at or above which the unit is kept running. */
export const BRIEF_NAMES_CHANNEL_MIN_P = 0.5;

export const BRIEF_NAMES_CHANNEL_QUESTION: NoulQuestion = {
  type: "noul",
  instructions:
    "A sales campaign states a brief: the strategy its owner wrote in plain language. An automatic planner wants to stop " +
    "giving new people to one channel of this campaign. Does the brief explicitly tell us to USE this channel (it names the " +
    "channel, by its name or an unmistakable description, as one to use)? A brief that only allows it, mentions it to " +
    "exclude it, or says nothing about it does not.",
  criteria: {
    true: "The brief explicitly names this channel as one to use.",
    false: "The brief does not name this channel as one to use (silent about it, or excludes it).",
  },
};

export type BriefChannelJudge = (unitId: string, input: { brief: string; channelName: string; channelSlug: string }) => Promise<number>;

export const judgeBriefNamesChannel: BriefChannelJudge = (unitId, input) =>
  judgeUnderCampaignRun(
    unitId,
    { brief: input.brief, channel: { name: input.channelName, slug: input.channelSlug } },
    { question: BRIEF_NAMES_CHANNEL_QUESTION, taskName: "plan-brief-channel-judgment" },
  );

export interface BriefGuardDeps {
  judgeBrief?: BriefChannelJudge;
  catalogue?: () => Promise<ChannelCatalogueRead>;
}

export type BriefGuard =
  | { ok: true; keep: Array<{ unitId: string; featureSlug: string; channelName: string; p: number }> }
  | { ok: false; detail: string };

/**
 * Which of the running units a plan change would drain does the brief name? Judged once per channel.
 * No brief or nothing to drain = nothing asked.
 */
export async function briefNamedUnits(
  row: Pick<SalesFunnelCampaign, "brief">,
  wouldDrain: ReadonlyArray<Pick<Campaign, "id" | "featureSlug" | "status">>,
  deps: BriefGuardDeps = {},
): Promise<BriefGuard> {
  const brief = row.brief?.trim();
  const running = wouldDrain.filter((u) => u.status === "ongoing");
  if (!brief || running.length === 0) return { ok: true, keep: [] };
  const catalogue = await (deps.catalogue ?? fetchChannelCatalogue)();
  if (!catalogue.ok) return { ok: false, detail: `channel catalogue unreadable: ${catalogue.detail}` };
  const judge = deps.judgeBrief ?? judgeBriefNamesChannel;
  const bySlug = new Map<string, number>();
  const keep: Array<{ unitId: string; featureSlug: string; channelName: string; p: number }> = [];
  for (const u of running) {
    const slug = u.featureSlug;
    if (!slug) continue;
    const channelName = catalogue.nameBySlug?.get(slug) ?? slug;
    let p = bySlug.get(slug);
    if (p === undefined) {
      try {
        p = await judge(u.id, { brief, channelName, channelSlug: slug });
      } catch (err) {
        return { ok: false, detail: `the brief could not be judged for ${channelName}: ${err instanceof Error ? err.message : String(err)}` };
      }
      bySlug.set(slug, p);
    }
    if (p >= BRIEF_NAMES_CHANNEL_MIN_P) keep.push({ unitId: u.id, featureSlug: slug, channelName, p });
  }
  return { ok: true, keep };
}
