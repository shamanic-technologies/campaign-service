/**
 * IS THIS ORG'S CARD BEING REFUSED? — billing's verdict, read and never re-derived.
 *
 * The owner's rule (2026-09-26): a declined card stops spending. When billing reports that it
 * cannot charge an org (the bank refused the card, the issuer killed it, the retry schedule ran
 * out, or the card's issuing country cannot be charged off-session), every campaign of that org is
 * stopped with `stop_reason = payment_declined`, and NO campaign of that org may be started again
 * until billing stops saying so — i.e. until what is owed has been paid AND a card billing can
 * actually charge is on file. Both halves are billing's to judge, so neither is judged here.
 *
 * WHERE THE VERDICT COMES FROM. billing-service already serves it:
 * `GET /internal/accounts/by-org/:orgId/payment-outlook` → `state: "charge_blocked"` with a named
 * `blockedReason`. That state is billing's own composition of the refused-card retry streak, the
 * permanently-unusable verdict and the unsupported-issuing-country check, and it clears on
 * billing's own tests (a successful charge, or `credited` moving because money arrived). This
 * module maps exactly one thing: `charge_blocked` means held. No reason is filtered, no balance is
 * compared, nothing is re-computed.
 *
 * Measured before shipping (2026-09-26, 22 billed orgs with campaigns in the last 120 days):
 * exactly two answered `charge_blocked` — `81b34252` (card_declined, balance −$49.98, one campaign
 * ongoing at $49/day) and `f74660b1` (card_country_unsupported, both campaigns already stopped by
 * hand). Every other org answered `will_charge`, `no_autopay` or `idle` and is untouched.
 *
 * THREE ANSWERS, NEVER ONE BOOLEAN. "Billing says this org is held", "billing says it is not" and
 * "billing could not be asked" lead to different actions: the sweep stops nothing on an unreadable
 * answer (a billing outage must not stop every customer's campaigns), while a person pressing start
 * is REFUSED on one (starting spend we cannot prove is paid for is the failure this exists to end).
 * A 404 is billing saying the org has no billing account at all — such an org has no card to be
 * refused, so it is not held.
 */

export type PaymentHoldRead =
  | { ok: true; held: false }
  | { ok: true; held: true; blockedReason: string }
  | { ok: false; detail: string };

export async function readPaymentHold(orgId: string): Promise<PaymentHoldRead> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) return { ok: false, detail: "billing not configured" };

  try {
    const res = await fetch(`${url}/internal/accounts/by-org/${orgId}/payment-outlook`, {
      headers: { "x-api-key": apiKey },
    });
    if (res.status === 404) return { ok: true, held: false };
    if (!res.ok) return { ok: false, detail: `billing responded ${res.status}` };

    const data = (await res.json()) as { state?: unknown; blockedReason?: unknown };
    if (typeof data.state !== "string") {
      return { ok: false, detail: "billing answered without a payment state" };
    }
    if (data.state !== "charge_blocked") return { ok: true, held: false };
    if (typeof data.blockedReason !== "string" || data.blockedReason.length === 0) {
      return { ok: false, detail: "billing said charge_blocked without naming why" };
    }
    return { ok: true, held: true, blockedReason: data.blockedReason };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "billing call threw" };
  }
}

/** What a customer reads when their card's state keeps a campaign from starting. */
function heldMessage(blockedReason: string): string {
  if (blockedReason === "card_country_unsupported") {
    return (
      "Your campaigns are paused because your card's issuing country can't be charged automatically. " +
      "Add a card we can charge and pay any outstanding balance, then start them again."
    );
  }
  return (
    "Your campaigns are paused because your card was declined. " +
    "Pay your outstanding balance and add a card that works, then start them again."
  );
}

export type StartRefusal = {
  status: number;
  body: { error: string; reason: "payment_declined" | "billing_unavailable"; blockedReason?: string };
};

/**
 * May a PERSON start work for this org right now? Null means yes; otherwise the refusal to send.
 *
 * Fail-CLOSED, unlike the sweep: this runs only when somebody presses start, it is rare, and
 * starting spend on an org whose payment state cannot be read is exactly what must not happen.
 * `error` is customer-facing English because the dashboard renders it verbatim; `reason` is the
 * code a consumer branches on.
 */
export async function paymentStartRefusal(orgId: string): Promise<StartRefusal | null> {
  const read = await readPaymentHold(orgId);
  if (!read.ok) {
    console.error(`[campaign-service] Payment state unreadable for org ${orgId}: ${read.detail}`);
    return {
      status: 502,
      body: {
        error: "We couldn't check your payment status just now, so nothing was started. Please try again in a minute.",
        reason: "billing_unavailable",
      },
    };
  }
  if (!read.held) return null;
  return {
    status: 409,
    body: { error: heldMessage(read.blockedReason), reason: "payment_declined", blockedReason: read.blockedReason },
  };
}
