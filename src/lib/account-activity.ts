/**
 * Tell crm-service what a CLIENT did to a campaign (CLIENT-ACTIVITY-1030, owner 2026-10-30: « ajoute une ligne
 * quand un client update / édite / crée une campagne ; aussi envoie un message TG »). crm-service files each fact
 * as a line on the client's thread in the staff Unibox and pings the owner on Telegram; this service owns every
 * campaign write, so it is the one that REPORTS. Contract (crm-service, served):
 *
 *   POST /internal/account-activity   (x-api-key CRM_SERVICE_API_KEY; x-org-id REQUIRED; x-user-id, x-email)
 *   { producer, activityId, type, title, subject {kind, id, name}, changes [{label, before, after}], brandId, occurredAt }
 *   -> 200 { id, stored, duplicate }   idempotent on (producer, activityId)
 *
 * ONLY A PERSON'S ACT. Every report rides a customer route (create / edit / pause / resume) and only when the
 * request names a person (`x-user-id`): sweeps, the payment hold, teardown and platform runs never come through
 * here. A client acting through the AI Copilot or the MCP is a person; crm-service drops staff actors itself.
 *
 * ONE report per request: a status move names the type (paused / resumed / created) and carries the edits made
 * in the same request; a request that moved nothing and changed nothing sends nothing.
 *
 * FIRE-AND-FORGET, the documented exception to fail-loud: called after the write committed, never awaited, never
 * throws, and never changes the route's status, body or latency. Every failure is logged.
 */

export const ACTIVITY_PRODUCER = "campaign-service";

export type CampaignActivityType = "campaign_created" | "campaign_updated" | "campaign_paused" | "campaign_resumed";

const TITLES: Record<CampaignActivityType, string> = {
  campaign_created: "Campaign created",
  campaign_updated: "Campaign edited",
  campaign_paused: "Campaign paused",
  campaign_resumed: "Campaign resumed",
};

export interface ActivityChange {
  label: string;
  before: string | null;
  after: string | null;
}

/** Who acted, as the request carried it. */
export interface ActivityActor {
  orgId: string;
  userId?: string | null;
  email?: string | null;
}

export interface CampaignActivity {
  type: CampaignActivityType;
  /** The campaign (or sales funnel campaign) acted on, by the name the client sees. */
  campaign: { id: string; name: string | null };
  brandId: string | null;
  changes?: ActivityChange[];
  /** When the write committed. With the campaign id and type, the fact's own id (idempotency at crm-service). */
  occurredAt: Date;
}

/** The type a status move is, or null when the status did not move. A birth (from null) is a creation. */
export function statusActivityType(fromStatus: string | null, toStatus: string): CampaignActivityType | null {
  if (fromStatus === null) return "campaign_created";
  if (fromStatus === toStatus) return null;
  if (toStatus === "ongoing") return "campaign_resumed";
  if (toStatus === "stopped") return "campaign_paused";
  return null;
}

/** The ONE report of a request: its status move if any, else an edit if something changed, else nothing. */
export function activityTypeOf(
  move: { fromStatus: string | null; toStatus: string } | null,
  changes: ActivityChange[],
): CampaignActivityType | null {
  const moved = move ? statusActivityType(move.fromStatus, move.toStatus) : null;
  if (moved) return moved;
  return changes.length > 0 ? "campaign_updated" : null;
}

/** A field a client edits, by the words the client reads, and how its value reads. */
export interface FieldLabel {
  label: string;
  format?: (value: unknown) => string | null;
}

const MAX_VALUE_CHARS = 500;

/** No em / en dash in anything we send (crm-service strips them too). */
function plain(s: string): string {
  const cleaned = s.replace(/[–—]/g, "-");
  return cleaned.length > MAX_VALUE_CHARS ? `${cleaned.slice(0, MAX_VALUE_CHARS - 3)}...` : cleaned;
}

function defaultFormat(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

export const usd = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : `$${Number(value).toFixed(2).replace(/\.00$/, "")}`;
export const cents = (value: unknown): string | null =>
  value === null || value === undefined ? null : usd(Number(value) / 100);
export const yesNo = (value: unknown): string | null => (value === null || value === undefined ? null : value ? "Yes" : "No");

/**
 * What changed between two versions of a row, over the fields a client edits (`labels`), in display strings.
 * A field whose display value did not change is not a change (a no-op save sends nothing).
 */
export function describeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  labels: Record<string, FieldLabel>,
): ActivityChange[] {
  const changes: ActivityChange[] = [];
  for (const [field, { label, format }] of Object.entries(labels)) {
    const fmt = format ?? defaultFormat;
    const from = fmt(before[field]);
    const to = fmt(after[field]);
    if (from === to) continue;
    changes.push({ label, before: from === null ? null : plain(from), after: to === null ? null : plain(to) });
  }
  return changes;
}

/** The fields a client edits on a campaign (PATCH /campaigns/:id, a create handing an incumbent back). */
export const CAMPAIGN_FIELD_LABELS: Record<string, FieldLabel> = {
  name: { label: "Name" },
  offerId: { label: "Offer" },
  audienceId: { label: "Audience" },
  brandProfileId: { label: "Brand profile" },
  activeGoalId: { label: "Goal" },
  featureInputs: { label: "Campaign settings" },
  servicesOffered: { label: "Services offered" },
  clickDestinationUrl: { label: "Link destination" },
  maxBudgetDailyUsd: { label: "Max daily budget", format: usd },
  maxBudgetWeeklyUsd: { label: "Max weekly budget", format: usd },
  maxBudgetMonthlyUsd: { label: "Max monthly budget", format: usd },
  maxBudgetTotalUsd: { label: "Max total budget", format: usd },
  dailyBudgetCents: { label: "Daily budget", format: cents },
  maxLeads: { label: "Max leads" },
  startDate: { label: "Start date" },
  endDate: { label: "End date" },
  notifyFrequency: { label: "Notification frequency" },
  notifyChannel: { label: "Notification channel" },
  notifyDestination: { label: "Notification destination" },
  whatsappSenderPhone: { label: "WhatsApp line" },
};

/** The fields a client edits on a sales funnel campaign. */
export const SALES_FUNNEL_CAMPAIGN_FIELD_LABELS: Record<string, FieldLabel> = {
  instruction: { label: "Instruction" },
  target: { label: "Target" },
  brief: { label: "Brief" },
  followsPlan: { label: "Follows its plan", format: yesNo },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let warnedUnconfigured = false;

/**
 * Report one fact to crm-service. Never awaited by a route, never throws. A request naming no person is not a
 * client's act and sends nothing.
 */
export async function reportCampaignActivity(actor: ActivityActor, activity: CampaignActivity): Promise<void> {
  try {
    if (!actor.userId) return;
    const url = process.env.CRM_SERVICE_URL;
    const apiKey = process.env.CRM_SERVICE_API_KEY;
    if (!url || !apiKey) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.error("[campaign-service] CRM_SERVICE_URL / CRM_SERVICE_API_KEY not set: client campaign actions are not reported to the staff Unibox");
      }
      return;
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "x-org-id": actor.orgId,
      "x-user-id": actor.userId,
    };
    if (actor.email) headers["x-email"] = actor.email;
    const occurredAt = activity.occurredAt.toISOString();
    const body = {
      producer: ACTIVITY_PRODUCER,
      activityId: `${activity.type}:${activity.campaign.id}:${occurredAt}`,
      type: activity.type,
      title: TITLES[activity.type],
      subject: { kind: "campaign", id: activity.campaign.id, name: activity.campaign.name ? plain(activity.campaign.name) : null },
      ...(activity.changes && activity.changes.length > 0 ? { changes: activity.changes.slice(0, 20) } : {}),
      // crm-service takes an internal brand uuid or nothing.
      brandId: activity.brandId && UUID.test(activity.brandId) ? activity.brandId : null,
      occurredAt,
    };
    const res = await fetch(`${url.replace(/\/$/, "")}/internal/account-activity`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.error(
        `[campaign-service] crm-service refused the account activity ${body.activityId} (org=${actor.orgId}): ${res.status} ${await res.text()}`,
      );
    }
  } catch (err) {
    console.error(`[campaign-service] account activity report failed (campaign=${activity.campaign.id}, ${activity.type}):`, err);
  }
}

/**
 * The route-side entry: decide the ONE report of a request from its status move and its edits, and send it in
 * the background. Never awaited, never throws.
 */
export function reportCampaignAction(
  actor: ActivityActor,
  campaign: { id: string; name: string | null; brandId: string | null },
  move: { fromStatus: string | null; toStatus: string } | null,
  changes: ActivityChange[],
  occurredAt: Date = new Date(),
): void {
  const type = activityTypeOf(move, changes);
  if (!type) return;
  void reportCampaignActivity(actor, {
    type,
    campaign: { id: campaign.id, name: campaign.name },
    brandId: campaign.brandId,
    changes: type === "campaign_created" ? [] : changes,
    occurredAt,
  });
}
