// Type-only: campaign-status-history imports THIS module, so a value import here is a cycle.
import type { TransitionSource } from "./campaign-status-history.js";

/**
 * Tell billing-service that a PERSON started, paused or restarted a campaign, so billing re-prices a
 * subscriber's plan (and invoices follow-up budgets that just went ON) and staff get the
 * budget-change email for it. A campaign's on/off is this service's status; billing only READS it.
 *
 * WHY BILLING SENDS IT. Pausing a mission moves the brand's real daily spend exactly as lowering its
 * ceiling does, and staff already get one email for that, composed by billing (which owns the
 * ceilings and reads the running split back from us). Owner rule: ONE email, one composition — so
 * this service only states WHAT moved and billing writes the words. Contract (billing-service):
 *
 *   POST /internal/brands/:brandId/mission-status-changed   (x-api-key, x-org-id; x-user-id,
 *   x-run-id, x-email when known)
 *   { campaignId, featureSlug, offerId, legKey, fromStatus, toStatus }  -> 202 { notified, move }
 *
 * ONLY A PERSON'S MOVE. A status is the customer's statement of intent (lib/stop-reason.ts); the
 * payment-hold sweep and an org teardown also write one, and neither is a person telling us
 * something about a mission, so they send nothing. A write that does not change the status sends
 * nothing either. A person CREATING a campaign ongoing is a move too (`fromStatus: null`): it turns
 * a budget ON exactly as a restart does (billing 2026-10-04: one budget per campaign).
 *
 * FIRE-AND-FORGET, the documented exception to fail-loud: it runs after the status write has
 * committed and must never change that route's response, status code or latency. Every failure is
 * logged and swallowed; nothing awaits it.
 */

/** The paths on which a PERSON moves a status. Everything else is the system, and sends nothing. */
export const PERSON_STATUS_SOURCES: ReadonlySet<TransitionSource> = new Set<TransitionSource>([
  "create", // TRANSITION_SOURCES.CREATE (a birth: fromStatus null)
  "patch", // TRANSITION_SOURCES.PATCH
  "create_restart", // TRANSITION_SOURCES.CREATE_RESTART
  "start_funded_pair", // TRANSITION_SOURCES.START_FUNDED_PAIR
  "proactive_switch", // TRANSITION_SOURCES.PROACTIVE_SWITCH (a person turned another proactive campaign on)
  "reactive_default", // TRANSITION_SOURCES.REACTIVE_DEFAULT (born on while a person acted on the offer)
]);

/** Who acted, as the request carried it. */
export interface StatusActor {
  userId?: string | null;
  runId?: string | null;
  email?: string | null;
}

export interface MissionStatusSignal {
  source: TransitionSource;
  orgId: string;
  campaignId: string;
  brandIds: string[] | null;
  featureSlug: string | null;
  offerId: string | null;
  legKey: string | null;
  fromStatus: string | null;
  toStatus: string;
  actor: StatusActor;
}

/** True when this write is a person's real move and billing should hear about it. */
export function shouldSignalStatusMove(s: Pick<MissionStatusSignal, "source" | "fromStatus" | "toStatus">): boolean {
  return PERSON_STATUS_SOURCES.has(s.source) && s.fromStatus !== s.toStatus;
}

export async function signalMissionStatusChanged(s: MissionStatusSignal): Promise<void> {
  try {
    if (!shouldSignalStatusMove(s)) return;
    const url = process.env.BILLING_SERVICE_URL;
    const apiKey = process.env.BILLING_SERVICE_API_KEY;
    if (!url || !apiKey) {
      console.error("[campaign-service] BILLING_SERVICE not configured — no staff email for a mission status move");
      return;
    }
    for (const brandId of s.brandIds ?? []) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "x-org-id": s.orgId,
      };
      if (s.actor.userId) headers["x-user-id"] = s.actor.userId;
      if (s.actor.runId) headers["x-run-id"] = s.actor.runId;
      if (s.actor.email) headers["x-email"] = s.actor.email;
      const res = await fetch(
        `${url.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/mission-status-changed`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            campaignId: s.campaignId,
            featureSlug: s.featureSlug,
            offerId: s.offerId,
            legKey: s.legKey,
            fromStatus: s.fromStatus,
            toStatus: s.toStatus,
          }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) {
        console.error(
          `[campaign-service] billing refused the mission status signal (campaign=${s.campaignId}, brand=${brandId}): ${res.status} ${await res.text()}`,
        );
      }
    }
  } catch (err) {
    console.error(`[campaign-service] mission status signal failed (campaign=${s.campaignId}):`, err);
  }
}
