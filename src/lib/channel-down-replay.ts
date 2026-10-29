import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { createRun, updateRun } from "@distribute/runs-client";
import { campaigns, triggerEventDeliveries, triggerEvents, type TriggerEventDelivery } from "../db/schema.js";
import { judgeNoul, type NoulQuestion } from "./jev-client.js";
import { ensureCampaignRunId } from "./trigger-run.js";

/**
 * A CHANNEL OUTAGE DELAYS A MESSAGE, IT NEVER DROPS IT (REPLAY-CHANNEL-DOWN-1023, owner 2026-10-23).
 *
 * Prod 2026-10-22: Jeremy gave his WhatsApp number to distribute.you at 16:36 UTC; the run answering the occurrence
 * was refused `whatsapp_not_connected` (the brand's WhatsApp had been logged out since 10-19). A sender refusal is
 * final (lib/trigger-deliveries.ts, PUSHED-TRUTH-1015), so when WhatsApp was relinked at 18:41 nothing resent it and
 * he never got his message.
 *
 * A refusal that only says "the sender's channel was unavailable" is not a verdict about the person: once the
 * channel is back, the same message goes through. So, for EVERY channel and brand, with no code list here:
 *  1. JUDGE: each refused delivery's code + sentence is put to Jev once ("refused only because the sender's channel
 *     was unavailable?"), persisted on the row (`channel_down_p`). The same code + sentence reuses the verdict (a
 *     channel down for days refuses with one sentence). Below `CHANNEL_DOWN_MIN_P` = `final`, never replayed.
 *  2. REPLAY: the occurrence is put back `pending` for THAT campaign only (`retryCampaignIds`, the redelivery path
 *     of lib/trigger-deliveries.ts), due `CHANNEL_DOWN_REPLAY_DELAYS_MS[n]` after the n-th channel-down refusal. It
 *     then fires like a fresh occurrence: the campaign's On/Off and caps, the person's filing (suppressed / opted
 *     out), their due state at lead-service (handed to the team), the workflow's own checks (someone of the brand
 *     wrote to them, they replied, they paid). Any of those ends it with its own reason. Still down = refused
 *     again, judged (cached), replayed later.
 *  3. HASTEN: a replay waiting on its delay is made due NOW as soon as another run of the same campaign
 *     delivered after the refusal (the channel works again).
 *  4. EXPIRE: a channel still down `CHANNEL_DOWN_REPLAY_MAX_AGE_MS` after the first such refusal ends it
 *     (`expired`, logged loud): the occurrence stays refused.
 * Only a refusal is ever replayed: a transient failure keeps its bounded redelivery, a person not admitted stays
 * final. Jev unreachable = nothing judged, nothing replayed, an error per sweep (never a guess).
 *
 * WHOSE WORK (PLATFORM-CALLER-RUN-1024): the judgment decides whether the campaign's message goes out again, so it
 * is that campaign's production, never support. Each Jev call runs under its OWN run, `campaign-service /
 * channel-down-judgment`, a child of the refused campaign's anchor run (lib/trigger-run.ts), tagged with the
 * campaign, sent as `x-run-id`: the judgment's spend lands in the campaign's tree. Never the refused delivery's
 * run id (workflow-service's). No run = no judgment (retried next sweep).
 */

/** Jev's P(channel down) at or above which a refusal is replayed. */
export const CHANNEL_DOWN_MIN_P = 0.7;
/** A channel still down this long after the first refusal: given up. Also the oldest refusal ever judged. */
export const CHANNEL_DOWN_REPLAY_MAX_AGE_MS = 14 * 24 * 3_600_000;
/** Delay after the n-th channel-down refusal (index n - 1; the last value repeats). */
export const CHANNEL_DOWN_REPLAY_DELAYS_MS = [10, 30, 60, 120, 240].map((m) => m * 60_000);
/** The hold named on the occurrence's `last_error` while it waits (`<campaignId> channel_unavailable`). */
export const CHANNEL_UNAVAILABLE_HOLD = "channel_unavailable";
/** How often the sweep runs. */
export const CHANNEL_DOWN_SWEEP_MS = 2 * 60_000;
const JUDGE_LIMIT = 10;
const SCHEDULE_LIMIT = 50;

export const REPLAY_STATE = { SCHEDULED: "scheduled", FINAL: "final", EXPIRED: "expired" } as const;

export const CHANNEL_DOWN_QUESTION: NoulQuestion = {
  type: "noul",
  instructions:
    "A message to one person was not sent: the service that sends it refused, with this code and sentence. " +
    "Was it refused ONLY because the sender's own channel was unavailable at that moment (its account or connection " +
    "logged out, disconnected, not linked, not connected, paused or down), so that the very same message to the same " +
    "person would go through once that channel is available again?",
  criteria: {
    true: "The refusal is about the sender's channel being unavailable (logged out, disconnected, not linked, not connected, down). Nothing in it is about the person, the message or a rule.",
    false:
      "The refusal is about the person (already contacted, replied, opted out, invalid or unverified address, not on that channel, someone already talking to them, too little known about them), about the message, about money or a rule, or anything else the channel coming back would not change.",
  },
};

/** The delay before replay n (n = channel-down refusals so far, >= 1). Pure. */
export function channelDownReplayDelayMs(refusals: number): number {
  const i = Math.min(Math.max(refusals, 1), CHANNEL_DOWN_REPLAY_DELAYS_MS.length) - 1;
  return CHANNEL_DOWN_REPLAY_DELAYS_MS[i];
}

/** Does the occurrence's `last_error` say it waits only on a channel replay? Pure. */
export function waitsOnlyOnChannel(lastError: string | null): boolean {
  if (!lastError) return false;
  const holds = [...lastError.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} ([a-z_]+)/g)].map((m) => m[1]);
  return holds.length > 0 && holds.every((h) => h === CHANNEL_UNAVAILABLE_HOLD);
}

const clip = (v: string, max: number) => (v.length > max ? v.slice(0, max) : v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const own = (detail: unknown): Record<string, unknown> =>
  detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};

let lastSweepAt = 0;

/** Test hook: forget when the sweep last ran. */
export function resetChannelDownSweepClock(): void {
  lastSweepAt = 0;
}

export interface ChannelDownSweep {
  judged: number;
  scheduled: Array<{ eventId: string; campaignId: string; dueAt: Date }>;
  expired: number;
  hastened: string[];
}

/** The scheduler's sweep (clocked). Never throws. */
export async function replayChannelDownRefusals(now: Date = new Date()): Promise<ChannelDownSweep | null> {
  if (now.getTime() - lastSweepAt < CHANNEL_DOWN_SWEEP_MS) return null;
  lastSweepAt = now.getTime();
  const out: ChannelDownSweep = { judged: 0, scheduled: [], expired: 0, hastened: [] };
  try {
    out.judged = await judgeRefusals(now);
  } catch (err) {
    console.error("[campaign-service] channel-down replay: refusals could not be judged (nothing replayed on a guess):", err);
  }
  try {
    const s = await scheduleChannelDownReplays(now);
    out.scheduled = s.scheduled;
    out.expired = s.expired;
  } catch (err) {
    console.error("[campaign-service] channel-down replay: replays could not be scheduled:", err);
  }
  try {
    out.hastened = await hastenReplaysOnChannelBack(now);
  } catch (err) {
    console.error("[campaign-service] channel-down replay: waiting replays could not be hastened:", err);
  }
  return out;
}

/** 1. Judge every refused delivery not judged yet (recent ones only). Returns how many were judged. */
export async function judgeRefusals(now: Date = new Date(), limit = JUDGE_LIMIT): Promise<number> {
  const since = new Date(now.getTime() - CHANNEL_DOWN_REPLAY_MAX_AGE_MS);
  const rows = await db
    .select()
    .from(triggerEventDeliveries)
    .where(and(
      eq(triggerEventDeliveries.status, "refused"),
      isNull(triggerEventDeliveries.channelDownJudgedAt),
      gt(triggerEventDeliveries.endedAt, since),
    ))
    .orderBy(triggerEventDeliveries.endedAt)
    .limit(limit);
  let judged = 0;
  for (const d of rows) {
    const code = d.refusalCode ?? "";
    const reason = d.refusalReason ?? "";
    // The same refusal text was judged already: its verdict stands (judged once, persisted).
    const [known] = await db
      .select({ p: triggerEventDeliveries.channelDownP })
      .from(triggerEventDeliveries)
      .where(and(
        isNotNull(triggerEventDeliveries.channelDownJudgedAt),
        isNotNull(triggerEventDeliveries.channelDownP),
        sql`${triggerEventDeliveries.refusalCode} IS NOT DISTINCT FROM ${d.refusalCode}`,
        sql`${triggerEventDeliveries.refusalReason} IS NOT DISTINCT FROM ${d.refusalReason}`,
      ))
      .limit(1);
    const p = known?.p ?? (await judgeUnderCampaignRun(d.campaignId, { refusalCode: code, refusalSentence: reason }));
    await db
      .update(triggerEventDeliveries)
      .set({ channelDownP: p, channelDownJudgedAt: now, replayState: p >= CHANNEL_DOWN_MIN_P ? null : REPLAY_STATE.FINAL })
      .where(eq(triggerEventDeliveries.id, d.id));
    console.log(
      `[campaign-service] refusal ${code} (delivery ${d.id}, event ${d.eventId}) judged P(channel down)=${p.toFixed(2)}${known ? " (same text judged before)" : ""}: ${p >= CHANNEL_DOWN_MIN_P ? "replayed once the channel is back" : "final"}`,
    );
    judged += 1;
  }
  return judged;
}

/**
 * One Jev call under a run of the campaign's own tree (opened, then closed completed / failed). The channel-down
 * question by default; another judgment of that campaign's production names its own question + task
 * (lib/sales-funnel-plan-brief.ts).
 */
export async function judgeUnderCampaignRun(
  campaignId: string,
  state: Record<string, unknown>,
  ask: { question: NoulQuestion; taskName: string } = { question: CHANNEL_DOWN_QUESTION, taskName: "channel-down-judgment" },
): Promise<number> {
  const [campaign] = await db
    .select({
      id: campaigns.id,
      orgId: campaigns.orgId,
      anchorRunId: campaigns.anchorRunId,
      createdByUserId: campaigns.createdByUserId,
      brandIds: campaigns.brandIds,
      brandId: campaigns.brandId,
      featureSlug: campaigns.featureSlug,
    })
    .from(campaigns)
    .where(sql`${campaigns.id}::text = ${campaignId}`)
    .limit(1);
  if (!campaign) throw new Error(`campaign ${campaignId} not found: no run to judge its refusal under`);
  const anchorRunId = await ensureCampaignRunId(campaign);
  const identity = {
    orgId: campaign.orgId,
    userId: campaign.createdByUserId ?? undefined,
    brandId: campaign.brandIds?.length ? campaign.brandIds.join(",") : (campaign.brandId ?? undefined),
    campaignId: campaign.id,
    featureSlug: campaign.featureSlug ?? undefined,
  };
  const run = await createRun({
    ...identity,
    parentRunId: anchorRunId,
    serviceName: "campaign-service",
    taskName: ask.taskName,
  });
  try {
    const p = await judgeNoul(state, ask.question, { runId: run.id });
    await updateRun(run.id, "completed", { ...identity, runId: run.id }).catch((e) =>
      console.error(`[campaign-service] ${ask.taskName} run ${run.id} could not be marked completed:`, e),
    );
    return p;
  } catch (err) {
    await updateRun(run.id, "failed", { ...identity, runId: run.id }).catch((e) =>
      console.error(`[campaign-service] ${ask.taskName} run ${run.id} could not be marked failed:`, e),
    );
    throw err;
  }
}

/** 2. Put back every occurrence whose LATEST delivery for a campaign was a channel-down refusal. */
export async function scheduleChannelDownReplays(now: Date = new Date()): Promise<{ scheduled: ChannelDownSweep["scheduled"]; expired: number }> {
  const candidates = await db
    .select()
    .from(triggerEventDeliveries)
    .where(sql`${triggerEventDeliveries.status} = 'refused'
      AND ${triggerEventDeliveries.replayState} IS NULL
      AND ${triggerEventDeliveries.channelDownP} >= ${CHANNEL_DOWN_MIN_P}
      AND NOT EXISTS (
        SELECT 1 FROM trigger_event_deliveries later
        WHERE later.event_id = ${triggerEventDeliveries.eventId}
          AND later.campaign_id = ${triggerEventDeliveries.campaignId}
          AND later.dispatched_at > ${triggerEventDeliveries.dispatchedAt}
      )`)
    .orderBy(triggerEventDeliveries.endedAt)
    .limit(SCHEDULE_LIMIT);

  const scheduled: ChannelDownSweep["scheduled"] = [];
  let expired = 0;
  for (const d of candidates) {
    const result = await scheduleOne(d, now);
    if (result.kind === "scheduled") scheduled.push({ eventId: d.eventId, campaignId: d.campaignId, dueAt: result.dueAt });
    if (result.kind === "expired") expired += 1;
  }
  return { scheduled, expired };
}

type ScheduleResult = { kind: "scheduled"; dueAt: Date } | { kind: "expired" } | { kind: "busy" } | { kind: "missing" };

async function scheduleOne(d: TriggerEventDelivery, now: Date): Promise<ScheduleResult> {
  const [chain] = await db
    .select({
      n: sql<number>`count(*)::int`,
      first: sql<string>`min(${triggerEventDeliveries.endedAt})`,
    })
    .from(triggerEventDeliveries)
    .where(and(
      eq(triggerEventDeliveries.eventId, d.eventId),
      eq(triggerEventDeliveries.campaignId, d.campaignId),
      eq(triggerEventDeliveries.status, "refused"),
      sql`${triggerEventDeliveries.channelDownP} >= ${CHANNEL_DOWN_MIN_P}`,
    ));
  const refusals = Math.max(chain?.n ?? 1, 1);
  const refusedAt = d.endedAt ?? d.dispatchedAt;
  const firstAt = chain?.first ? new Date(chain.first) : refusedAt;
  const code = d.refusalCode ?? "refused";

  if (now.getTime() - firstAt.getTime() > CHANNEL_DOWN_REPLAY_MAX_AGE_MS) {
    await db.update(triggerEventDeliveries).set({ replayState: REPLAY_STATE.EXPIRED }).where(eq(triggerEventDeliveries.id, d.id));
    console.error(
      `[campaign-service] trigger event ${d.eventId}: campaign ${d.campaignId}'s channel stayed unavailable since ${firstAt.toISOString()} (${code}, ${refusals} refusals): not replayed again, the occurrence stays refused`,
    );
    return { kind: "expired" };
  }

  const dueAt = new Date(Math.max(refusedAt.getTime() + channelDownReplayDelayMs(refusals), now.getTime()));
  const outcome = await db.transaction(async (tx) => {
    const [event] = await tx.select().from(triggerEvents).where(eq(triggerEvents.id, d.eventId)).for("update");
    if (!event) return "missing" as const;
    if (event.status === "firing") return "busy" as const;
    const detail = own(event.detail);
    const replays = [
      ...(Array.isArray(detail.channelDownReplays) ? detail.channelDownReplays : []),
      { campaignId: d.campaignId, afterRunId: d.runId, code, refusedAt: refusedAt.toISOString(), attempt: refusals, dueAt: dueAt.toISOString() },
    ];
    const hold = clip(`${d.campaignId} ${CHANNEL_UNAVAILABLE_HOLD} (${code}): ${d.refusalReason ?? ""}; replayed at ${dueAt.toISOString()}`, 500);
    if (event.status === "pending") {
      // Already owed: to every campaign (no list, this one included) or to a list this campaign joins.
      if (Array.isArray(detail.retryCampaignIds)) {
        await tx
          .update(triggerEvents)
          .set({
            dueAt: event.dueAt.getTime() < dueAt.getTime() ? event.dueAt : dueAt,
            detail: { ...detail, retryCampaignIds: [...new Set([...strings(detail.retryCampaignIds), d.campaignId])], channelDownReplays: replays },
          })
          .where(eq(triggerEvents.id, event.id));
      }
      return "applied" as const;
    }
    await tx
      .update(triggerEvents)
      .set({
        status: "pending",
        dueAt,
        claimedAt: null,
        outcome: null,
        skipReason: null,
        detail: {
          ...detail,
          // Only the refused campaign is asked again; a campaign that ran stays ran and is never dispatched twice.
          retryCampaignIds: [d.campaignId],
          priorRanCampaignIds: event.ranCampaignIds ?? [],
          // Young again at the replay (lib/trigger-events.ts): a passing hold then gets its short retries.
          redeliveredAt: dueAt.toISOString(),
          channelDownReplays: replays,
        },
        lastError: hold,
      })
      .where(eq(triggerEvents.id, event.id));
    return "applied" as const;
  });
  if (outcome === "busy") return { kind: "busy" };
  if (outcome === "missing") {
    await db.update(triggerEventDeliveries).set({ replayState: REPLAY_STATE.FINAL }).where(eq(triggerEventDeliveries.id, d.id));
    console.error(`[campaign-service] delivery ${d.id}: trigger event ${d.eventId} no longer exists, nothing to replay`);
    return { kind: "missing" };
  }
  await db.update(triggerEventDeliveries).set({ replayState: REPLAY_STATE.SCHEDULED }).where(eq(triggerEventDeliveries.id, d.id));
  console.warn(
    `[campaign-service] trigger event ${d.eventId}: campaign ${d.campaignId}'s channel was unavailable (${code}, refusal ${refusals}); replayed at ${dueAt.toISOString()}`,
  );
  return { kind: "scheduled", dueAt };
}

/** 3. A replay waiting on its delay fires now once another run of its campaign delivered after the refusal. */
export async function hastenReplaysOnChannelBack(now: Date = new Date()): Promise<string[]> {
  const waiting = await db
    .select()
    .from(triggerEvents)
    .where(sql`${triggerEvents.status} = 'pending'
      AND ${triggerEvents.dueAt} > ${now.toISOString()}::timestamptz
      AND coalesce(${triggerEvents.detail}, '{}'::jsonb) ? 'channelDownReplays'`)
    .limit(SCHEDULE_LIMIT);
  const hastened: string[] = [];
  for (const event of waiting) {
    const detail = own(event.detail);
    const retry = new Set(strings(detail.retryCampaignIds));
    const replays = (Array.isArray(detail.channelDownReplays) ? detail.channelDownReplays : []) as Array<{ campaignId?: unknown; refusedAt?: unknown }>;
    const latest = new Map<string, string>();
    for (const r of replays) {
      if (typeof r?.campaignId === "string" && typeof r.refusedAt === "string" && retry.has(r.campaignId)) latest.set(r.campaignId, r.refusedAt);
    }
    let back = false;
    for (const [campaignId, refusedAt] of latest) {
      const [delivered] = await db
        .select({ id: triggerEventDeliveries.id })
        .from(triggerEventDeliveries)
        .where(and(
          eq(triggerEventDeliveries.campaignId, campaignId),
          eq(triggerEventDeliveries.status, "completed"),
          gt(triggerEventDeliveries.endedAt, new Date(refusedAt)),
        ))
        .limit(1);
      if (delivered) back = true;
    }
    if (!back) continue;
    const moved = await db
      .update(triggerEvents)
      .set({ dueAt: now })
      .where(and(eq(triggerEvents.id, event.id), eq(triggerEvents.status, "pending")))
      .returning({ id: triggerEvents.id });
    if (moved.length > 0) {
      hastened.push(event.id);
      console.log(`[campaign-service] trigger event ${event.id}: its campaign delivered again since the channel refusal, replayed now`);
    }
  }
  return hastened;
}
