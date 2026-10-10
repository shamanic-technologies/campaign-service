import { and, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  campaigns,
  campaignStatusTransitions,
  salesFunnelCampaigns,
  type NewCampaignStatusTransition,
  type SalesFunnelCampaign,
} from "../db/schema.js";
import { signalMissionStatusChanged, type StatusActor } from "./mission-status-notification.js";
import { STOP_REASONS } from "./stop-reason.js";

/** The transaction handle `db.transaction` hands its callback. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A campaign's STATUS is the customer's statement of intent, and every change to it leaves a
 * trace. This module is the ONLY place a status is written.
 *
 * The reason it is one place rather than a convention is what the trace is FOR: somebody reading
 * the company's run-rate for a past month needs to know, for any past day, whether each campaign
 * was actually earning — and paused is not MRR. A status change that lands without a transition
 * row is a day that can never be replayed, and it is invisible: nothing errors, no test goes red,
 * the campaign behaves perfectly, and the hole only surfaces months later as a run-rate nobody can
 * reproduce. So the update and its trace are written in ONE transaction: either both land or
 * neither does, and no call site can perform half of it.
 *
 * `tests/unit/no-legacy.test.ts` fails if a status is written to `campaigns` anywhere else.
 */

/** WHICH path wrote a transition. Every path that changes a status is named here. */
export const TRANSITION_SOURCES = {
  /** POST /campaigns inserted a new campaign — its birth. */
  CREATE: "create",
  /** POST /campaigns matched an existing campaign; the customer is (re)starting it. */
  CREATE_RESTART: "create_restart",
  /** PATCH /campaigns/:id with status=activate|stop — a person's decision. */
  PATCH: "patch",
  /**
   * POST /campaigns/start-funded-pair — the customer pressed start on a channel they fund. Its
   * own source rather than CREATE_RESTART so the ledger says which surface a person acted on;
   * both are a person's explicit act and nothing else may write either.
   */
  START_FUNDED_PAIR: "start_funded_pair",
  /** DELETE /internal/campaigns/by-org/:orgId — the org is gone. */
  ORG_TEARDOWN: "org_teardown",
  /**
   * A person turned ANOTHER proactive campaign of the same offer ON, which stops this one in the
   * same transaction (owner 2026-10-05: one proactive campaign on per offer, lib/single-proactive.ts).
   * The person's act, so billing hears it; the stop reason is `manual`.
   */
  PROACTIVE_SWITCH: "proactive_switch",
  /**
   * A reactive campaign born ON because a sales path the offer ticked uses it (owner 2026-10-05:
   * reactive campaigns are on by default). Only ever written while a person acts on the offer
   * (starting its proactive campaign, or saving its sales paths); never by a tick.
   */
  REACTIVE_DEFAULT: "reactive_default",
  /**
   * A SOURCE campaign born ON because a person started its offer's first outreach campaign of a
   * sourced channel and the offer had no source campaign at all (lib/source-campaign-store.ts).
   */
  SOURCE_DEFAULT: "source_default",
  /**
   * A SOURCE campaign born MIRRORING its offer's outreach campaign when sources became campaigns
   * (owner 2026-10-07, `POST /internal/source-campaigns/mirror`). Never written by a person or a tick.
   */
  SOURCE_MIRROR: "source_mirror",
  /**
   * A SOURCE campaign that NO PERSON ever turned off (stopped by the mirror's inherited copy of its
   * outreach campaign's pause, or by the payment hold) turned back ON because a person started an
   * outreach campaign it feeds (owner 2026-10-09, lib/source-campaign-store.ts). Only ever written
   * while a person starts an outreach campaign; never by a tick.
   */
  SOURCE_FOLLOWS_OUTREACH: "source_follows_outreach",
  /**
   * A SALES FUNNEL campaign moved, and every unit (pipe) of it with it, in one transaction (owner
   * 2026-10-10, lib/sales-funnel-campaigns.ts): its birth, its run, its pause. A person's act, but
   * NOT signalled to billing per pipe: a funnel's money is billing's funnel caps, so moving a
   * subscriber's per-pipe plan money on a unit's move would be a money change nobody asked for.
   */
  SALES_FUNNEL: "sales_funnel",
  /** The payment-hold sweep: billing cannot charge the org's card (lib/payment-hold-sweep.ts). */
  PAYMENT_HOLD: "payment_hold",
  /** Migration 0057 opened the record by observing the PRESENT. Never written by the runtime. */
  RECORD_OPENED: "record_opened",
} as const;

export type TransitionSource = (typeof TRANSITION_SOURCES)[keyof typeof TRANSITION_SOURCES];

type StatusWrite = {
  campaignId: string;
  orgId: string;
  /** The status the row held before this write, as read by the caller. NULL for a birth. */
  fromStatus: string | null;
  toStatus: string;
  /** The stop reason that accompanies this transition (STOP_REASONS), or null. */
  reason: string | null;
  source: TransitionSource;
  /** Everything else the same write sets — nextRunAt, workflowSlug, the caller's own fields. */
  fields?: Record<string, unknown>;
  /**
   * The person who made this move, when a person did. After the write commits, a person's real
   * move is signalled to billing-service for the staff email (lib/mission-status-notification.ts).
   */
  actor?: StatusActor;
  /**
   * Campaigns this start turns OFF, chosen inside the same transaction after the status write
   * (lib/single-proactive.ts). Each is stopped with reason `manual` and source `proactive_switch`,
   * and signalled to billing with the same actor. A throw rolls the whole write back.
   */
  displace?: (tx: DbTransaction, updated: CampaignRow) => Promise<CampaignRow[]>;
};

type CampaignRow = typeof campaigns.$inferSelect;

/**
 * Change a campaign's status AND record the transition, atomically.
 *
 * Returns the updated row, or null when the id matched nothing (the caller decides what that
 * means; nothing is recorded for a campaign that was not there).
 */
export async function setCampaignStatus(write: StatusWrite) {
  return (await setCampaignStatusWithStops(write)).campaign;
}

/**
 * `setCampaignStatus`, also answering which campaigns the write's `displace` stopped. The status
 * write, its trace, and every displaced stop with ITS trace land in ONE transaction.
 */
export async function setCampaignStatusWithStops(
  write: StatusWrite,
): Promise<{ campaign: CampaignRow | null; stopped: CampaignRow[] }> {
  let stopped: CampaignRow[] = [];
  const updated = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(campaigns)
      .set({
        ...(write.fields ?? {}),
        status: write.toStatus,
        stopReason: write.reason,
        updatedAt: new Date(),
      })
      .where(and(eq(campaigns.id, write.campaignId), eq(campaigns.orgId, write.orgId)))
      .returning();

    if (!updated) return null;

    await tx.insert(campaignStatusTransitions).values({
      campaignId: write.campaignId,
      orgId: write.orgId,
      fromStatus: write.fromStatus,
      toStatus: write.toStatus,
      reason: write.reason,
      source: write.source,
    });

    if (write.displace) {
      stopped = await stopDisplacedWithHistory(tx, write.orgId, await write.displace(tx, updated));
    }

    return updated;
  });

  // After the commit, never awaited: the staff email must not touch this write's outcome.
  if (updated && write.actor) {
    void signalMissionStatusChanged({
      source: write.source,
      orgId: write.orgId,
      campaignId: write.campaignId,
      brandIds: updated.brandIds ?? null,
      featureSlug: updated.featureSlug ?? null,
      offerId: updated.offerId ?? null,
      legKey: updated.legKey ?? null,
      fromStatus: write.fromStatus,
      toStatus: write.toStatus,
      actor: write.actor,
    });
  }
  if (write.actor) signalDisplacedStops(stopped, write.actor);
  return { campaign: updated ?? null, stopped };
}

/**
 * Stop the campaigns a person's start displaced, recording one `proactive_switch` transition each,
 * inside the transaction that started the replacement. Reason `manual`: the person who turned the
 * other one on said so. Returns the stopped rows (status already `stopped`).
 */
export async function stopDisplacedWithHistory(
  tx: DbTransaction,
  orgId: string,
  rows: CampaignRow[],
): Promise<CampaignRow[]> {
  if (rows.length === 0) return [];
  const stopped = await tx
    .update(campaigns)
    .set({ status: "stopped", stopReason: STOP_REASONS.MANUAL, nextRunAt: null, updatedAt: new Date() })
    .where(and(eq(campaigns.orgId, orgId), eq(campaigns.status, "ongoing"), inArray(campaigns.id, rows.map((r) => r.id))))
    .returning();
  if (stopped.length === 0) return [];
  await tx.insert(campaignStatusTransitions).values(
    stopped.map((c) => ({
      campaignId: c.id,
      orgId,
      fromStatus: "ongoing",
      toStatus: "stopped",
      reason: STOP_REASONS.MANUAL,
      source: TRANSITION_SOURCES.PROACTIVE_SWITCH,
    })),
  );
  return stopped;
}

/**
 * Start the SOURCE campaigns a person's outreach start brings back ON (stopped, never by a person:
 * lib/source-campaign-store.ts decides which), recording one `source_follows_outreach` transition
 * each, inside the transaction that started the outreach campaign. A source has no workflow, so
 * nothing is scheduled. Returns the started rows.
 */
export async function startFollowingSourcesWithHistory(
  tx: DbTransaction,
  orgId: string,
  ids: string[],
): Promise<CampaignRow[]> {
  if (ids.length === 0) return [];
  const started = await tx
    .update(campaigns)
    .set({ status: "ongoing", stopReason: null, nextRunAt: null, updatedAt: new Date() })
    .where(and(eq(campaigns.orgId, orgId), eq(campaigns.status, "stopped"), inArray(campaigns.id, ids)))
    .returning();
  if (started.length === 0) return [];
  await tx.insert(campaignStatusTransitions).values(
    started.map((c) => ({
      campaignId: c.id,
      orgId,
      fromStatus: "stopped",
      toStatus: "ongoing",
      reason: null,
      source: TRANSITION_SOURCES.SOURCE_FOLLOWS_OUTREACH,
    })),
  );
  return started;
}

/** After the commit, never awaited: billing hears each displaced stop as the person's move. */
export function signalDisplacedStops(stopped: CampaignRow[], actor: StatusActor): void {
  for (const c of stopped) {
    void signalMissionStatusChanged({
      source: TRANSITION_SOURCES.PROACTIVE_SWITCH,
      orgId: c.orgId,
      campaignId: c.id,
      brandIds: c.brandIds ?? null,
      featureSlug: c.featureSlug ?? null,
      offerId: c.offerId ?? null,
      legKey: c.legKey ?? null,
      fromStatus: "ongoing",
      toStatus: "stopped",
      actor,
    });
  }
}

/**
 * A person created a campaign (its birth committed): signal it like any other person's move, so
 * billing re-prices on a budget turned ON. Call AFTER the inserting transaction commits; never
 * awaited by the route, never throws.
 */
export function signalCampaignBirth(
  inserted: {
    id: string;
    orgId: string;
    status: string;
    brandIds: string[] | null;
    featureSlug: string | null;
    offerId: string | null;
    legKey: string | null;
  },
  actor: StatusActor,
  source: TransitionSource = TRANSITION_SOURCES.CREATE,
): void {
  void signalMissionStatusChanged({
    source,
    orgId: inserted.orgId,
    campaignId: inserted.id,
    brandIds: inserted.brandIds ?? null,
    featureSlug: inserted.featureSlug ?? null,
    offerId: inserted.offerId ?? null,
    legKey: inserted.legKey ?? null,
    fromStatus: null,
    toStatus: inserted.status,
    actor,
  });
}

/**
 * Stop every campaign an org holds, recording one transition each — inside a transaction the
 * caller already owns (the teardown does more than campaigns in the same atomic step). The caller
 * names which path it is (org teardown, payment hold) so the ledger says why.
 *
 * The rows are read BEFORE they are updated, so each transition states the status it actually
 * came from rather than leaving it unstated.
 */
export async function stopOrgCampaignsWithHistory(
  tx: DbTransaction,
  orgId: string,
  reason: string,
  predicate: SQL | undefined,
  source: TransitionSource,
): Promise<{ id: string }[]> {
  const before = await tx
    .select({ id: campaigns.id, status: campaigns.status })
    .from(campaigns)
    .where(predicate);

  if (before.length === 0) return [];

  const updated = await tx
    .update(campaigns)
    .set({ status: "stopped", stopReason: reason, nextRunAt: null, updatedAt: new Date() })
    .where(predicate)
    .returning({ id: campaigns.id, salesFunnelCampaignId: campaigns.salesFunnelCampaignId });

  const statusById = new Map(before.map((c) => [c.id, c.status]));
  await tx.insert(campaignStatusTransitions).values(
    updated.map((c) => ({
      campaignId: c.id,
      orgId,
      fromStatus: statusById.get(c.id) ?? null,
      toStatus: "stopped",
      reason,
      source,
    })),
  );

  // A SALES FUNNEL campaign and its units are one status (lib/sales-funnel-campaigns.ts): when an
  // org-wide stop reaches a unit, the funnel campaign that owns it stops in the same transaction,
  // with the same reason, so a funnel can never read "ongoing" over stopped pipes.
  const parentIds = [
    ...new Set(updated.map((c) => c.salesFunnelCampaignId).filter((id): id is string => !!id)),
  ];
  if (parentIds.length > 0) {
    await tx
      .update(salesFunnelCampaigns)
      .set({ status: "stopped", stopReason: reason, updatedAt: new Date() })
      .where(and(
        eq(salesFunnelCampaigns.orgId, orgId),
        eq(salesFunnelCampaigns.status, "ongoing"),
        inArray(salesFunnelCampaigns.id, parentIds),
      ));
  }

  return updated.map(({ id }) => ({ id }));
}

// === Sales funnel campaigns (owner 2026-10-10, lib/sales-funnel-campaigns.ts) ===

/** One unit to be born with its funnel campaign: a pipe, already resolved. */
export interface SalesFunnelUnitBirth {
  featureSlug: string;
  legKey: string;
  workflowSlug: string | null;
  name: string;
  acquisitionChannel: string;
}

/**
 * Called inside the transaction for every unit that is (now) ongoing, AFTER its status is written:
 * the route's hook for what a person's start brings with it (an offer's lead sources). Kept as a
 * callback because that module imports this one.
 */
export type OnUnitStarted = (tx: DbTransaction, unit: CampaignRow) => Promise<void>;

/**
 * A SALES FUNNEL campaign's BIRTH: the funnel row, one `campaigns` row per pipe, and each unit's
 * birth transition (source `sales_funnel`), in ONE transaction. Every unit is born in the funnel's
 * status: a funnel created stopped starts nothing.
 */
export async function insertSalesFunnelCampaignWithUnits(input: {
  /** Minted by the caller so the units' names can carry it (names are unique per org). */
  id: string;
  orgId: string;
  brandId: string;
  offerId: string;
  salesFunnelId: string;
  salesFunnelName: string;
  status: "ongoing" | "stopped";
  createdByUserId: string | null;
  parentRunId: string | null;
  units: SalesFunnelUnitBirth[];
  onUnitStarted?: OnUnitStarted;
}): Promise<{ salesFunnelCampaign: SalesFunnelCampaign; units: CampaignRow[] }> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [parent] = await tx
      .insert(salesFunnelCampaigns)
      .values({
        id: input.id,
        orgId: input.orgId,
        brandId: input.brandId,
        offerId: input.offerId,
        salesFunnelId: input.salesFunnelId,
        salesFunnelName: input.salesFunnelName,
        status: input.status,
        stopReason: input.status === "stopped" ? STOP_REASONS.MANUAL : null,
        createdByUserId: input.createdByUserId,
        parentRunId: input.parentRunId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const units = await tx
      .insert(campaigns)
      .values(input.units.map((u) => ({
        orgId: input.orgId,
        createdByUserId: input.createdByUserId,
        parentRunId: input.parentRunId,
        name: u.name,
        workflowSlug: u.workflowSlug,
        brandIds: [input.brandId],
        brandId: input.brandId,
        acquisitionChannel: u.acquisitionChannel,
        featureSlug: u.featureSlug,
        offerId: input.offerId,
        legKey: u.legKey,
        salesFunnelId: input.salesFunnelId,
        salesFunnelCampaignId: parent.id,
        featureInputs: null,
        status: input.status,
        stopReason: input.status === "stopped" ? STOP_REASONS.MANUAL : null,
        // A unit with no DAG is never due; a stopped one is not claimed whatever this says.
        nextRunAt: input.status === "ongoing" && u.workflowSlug ? now : null,
        createdAt: now,
        updatedAt: now,
      })))
      .returning();

    await tx.insert(campaignStatusTransitions).values(
      units.map((u) => campaignBirthTransition(u.id, input.orgId, u.status, TRANSITION_SOURCES.SALES_FUNNEL)),
    );
    if (input.status === "ongoing" && input.onUnitStarted) {
      for (const unit of units) await input.onUnitStarted(tx, unit);
    }
    return { salesFunnelCampaign: parent, units };
  });
}

/**
 * Run or pause a SALES FUNNEL campaign: the funnel row and EVERY unit move together, each unit's
 * transition recorded (source `sales_funnel`), in ONE transaction. A unit already in the target
 * status gets no transition (nothing moved). Returns null when the funnel campaign is not the org's.
 */
export async function setSalesFunnelCampaignStatus(write: {
  salesFunnelCampaignId: string;
  orgId: string;
  toStatus: "ongoing" | "stopped";
  reason: string | null;
  onUnitStarted?: OnUnitStarted;
}): Promise<{ salesFunnelCampaign: SalesFunnelCampaign; units: CampaignRow[]; moved: CampaignRow[] } | null> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [parent] = await tx
      .update(salesFunnelCampaigns)
      .set({ status: write.toStatus, stopReason: write.reason, updatedAt: now })
      .where(and(eq(salesFunnelCampaigns.id, write.salesFunnelCampaignId), eq(salesFunnelCampaigns.orgId, write.orgId)))
      .returning();
    if (!parent) return null;

    const before = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.orgId, write.orgId), eq(campaigns.salesFunnelCampaignId, parent.id)));
    const toMove = before.filter((u) => u.status !== write.toStatus);

    const moved: CampaignRow[] = [];
    for (const unit of toMove) {
      const [row] = await tx
        .update(campaigns)
        .set({
          status: write.toStatus,
          stopReason: write.reason,
          // Due now when it starts (the scheduler's planner decides whether it may spend); nothing
          // due once stopped.
          nextRunAt: write.toStatus === "ongoing" && unit.workflowSlug ? now : null,
          updatedAt: now,
        })
        .where(eq(campaigns.id, unit.id))
        .returning();
      moved.push(row);
    }
    if (moved.length > 0) {
      await tx.insert(campaignStatusTransitions).values(
        moved.map((u) => ({
          campaignId: u.id,
          orgId: write.orgId,
          fromStatus: toMove.find((b) => b.id === u.id)!.status,
          toStatus: write.toStatus,
          reason: write.reason,
          source: TRANSITION_SOURCES.SALES_FUNNEL,
        })),
      );
    }
    if (write.toStatus === "ongoing" && write.onUnitStarted) {
      for (const unit of moved) await write.onUnitStarted(tx, unit);
    }
    const movedById = new Map(moved.map((u) => [u.id, u]));
    const units = before.map((u) => movedById.get(u.id) ?? u);
    return { salesFunnelCampaign: parent, units, moved };
  });
}

/**
 * Record transitions inside a transaction the caller already owns — the campaign INSERT leg,
 * which writes the row and its birth together.
 */
export async function insertCampaignStatusTransitions(
  tx: DbTransaction,
  rows: NewCampaignStatusTransition[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(campaignStatusTransitions).values(rows);
}

/**
 * Record a campaign's BIRTH. Called inside the same transaction that inserts it.
 *
 * A birth is a transition like any other — `fromStatus` NULL — because a replay must be able to
 * tell "this campaign did not exist yet" from "it existed and was stopped", and from "we were not
 * recording yet". Three different answers, and only the first two are knowable from a row.
 */
export function campaignBirthTransition(
  campaignId: string,
  orgId: string,
  status: string,
  source: TransitionSource = TRANSITION_SOURCES.CREATE,
): NewCampaignStatusTransition {
  return {
    campaignId,
    orgId,
    fromStatus: null,
    toStatus: status,
    reason: null,
    source,
  };
}
