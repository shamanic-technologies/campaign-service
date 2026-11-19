/**
 * CAMPAIGN-CHANGE-LOG-1119: the history of a funnel campaign's own words (target, brief, follows-its-plan). Each was
 * overwritten in place, so "what did the brief say on the 4th" had no answer. Every write that CHANGES one of them
 * appends one row per field to `sales_funnel_campaign_setting_changes` in the SAME transaction (append-only; before
 * migration 0090 = not recorded, never backfilled). Read by `GET /sales-funnel-campaigns/:id/change-history`.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { salesFunnelCampaignSettingChanges } from "../db/schema.js";

/** The day migration 0090 shipped: a funnel campaign's words before it are not recorded. */
export const SETTING_CHANGES_RECORDED_SINCE = "2026-11-19";

export type SettingField = "target" | "brief" | "follows_plan";
/** The path that wrote it: a caller's stated edit, a campaign's birth, the brief written from its offer, the target read off its funnel. */
export type SettingSource = "edit" | "birth" | "birth_brief" | "target_backfill";

export interface SettingWords {
  target?: string | null;
  brief?: string | null;
  followsPlan?: boolean | null;
}

export interface SettingChangeRow {
  salesFunnelCampaignId: string;
  orgId: string;
  field: SettingField;
  beforeValue: string | null;
  afterValue: string | null;
  changedByUserId: string | null;
  source: SettingSource;
}

const asText = (v: string | boolean | null | undefined): string | null => (v === undefined || v === null ? null : typeof v === "boolean" ? (v ? "yes" : "no") : v);

/**
 * PURE. One row per field the write CHANGES (stated and different from before). `before` null = a birth: every
 * stated field is a row from nothing.
 */
export function settingChangeRowsOf(
  campaign: { id: string; orgId: string },
  before: SettingWords | null,
  after: SettingWords,
  changedByUserId: string | null,
  source: SettingSource,
): SettingChangeRow[] {
  const fields: Array<[SettingField, keyof SettingWords]> = [
    ["target", "target"],
    ["brief", "brief"],
    ["follows_plan", "followsPlan"],
  ];
  const rows: SettingChangeRow[] = [];
  for (const [field, k] of fields) {
    if (after[k] === undefined) continue;
    const was = asText(before?.[k]);
    const is = asText(after[k]);
    if (was === is) continue;
    if (before === null && is === null) continue;
    rows.push({ salesFunnelCampaignId: campaign.id, orgId: campaign.orgId, field, beforeValue: was, afterValue: is, changedByUserId, source });
  }
  return rows;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Append the rows inside the caller's transaction. Nothing to append = no write. */
export async function appendSettingChanges(tx: Tx | typeof db, rows: readonly SettingChangeRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(salesFunnelCampaignSettingChanges).values(rows.map((r) => ({ ...r })));
}

/** Every recorded change of one funnel campaign, oldest first. */
export async function readSettingChanges(salesFunnelCampaignId: string) {
  return db
    .select()
    .from(salesFunnelCampaignSettingChanges)
    .where(eq(salesFunnelCampaignSettingChanges.salesFunnelCampaignId, salesFunnelCampaignId))
    .orderBy(asc(salesFunnelCampaignSettingChanges.changedAt), asc(salesFunnelCampaignSettingChanges.id));
}
