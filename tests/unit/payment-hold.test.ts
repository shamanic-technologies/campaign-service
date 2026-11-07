import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// tests/setup.ts mocks this module fleet-wide; this file tests the REAL one.
const { readPaymentHold, paymentStartRefusal, paymentStopReason } = await vi.importActual<
  typeof import("../../src/lib/payment-hold.js")
>("../../src/lib/payment-hold.js");

const ORG = "81b34252-61e3-47b5-9293-5294b6fb51b6";
const originalFetch = global.fetch;

function answer(status: number, body: unknown) {
  global.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("readPaymentHold — billing's charge verdict, read and never re-derived", () => {
  beforeEach(() => {
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("asks billing's charge verdict for the org, with the service key only", async () => {
    answer(200, { chargeBlocked: false, blockedReason: null });
    await readPaymentHold(ORG);
    expect(global.fetch).toHaveBeenCalledWith(
      `https://billing.test.local/internal/accounts/by-org/${ORG}/charge-verdict`,
      { headers: { "x-api-key": "billing-key" }, signal: expect.any(AbortSignal) },
    );
  });

  it("charge_blocked is held, carrying billing's own reason verbatim", async () => {
    answer(200, { chargeBlocked: true, blockedReason: "card_declined", paymentMode: "postpaid" });
    expect(await readPaymentHold(ORG)).toEqual({ ok: true, held: true, blockedReason: "card_declined" });

    answer(200, { chargeBlocked: true, blockedReason: "card_country_unsupported", paymentMode: "postpaid" });
    expect(await readPaymentHold(ORG)).toEqual({ ok: true, held: true, blockedReason: "card_country_unsupported" });
  });

  it("chargeBlocked false is not held — only billing saying it cannot charge holds an org", async () => {
    answer(200, { chargeBlocked: false, blockedReason: null, paymentMode: "prepaid" });
    expect(await readPaymentHold(ORG)).toEqual({ ok: true, held: false });
  });

  it("an org with no billing account (404) has no card to be refused", async () => {
    answer(404, { error: "No billing account for this org" });
    expect(await readPaymentHold(ORG)).toEqual({ ok: true, held: false });
  });

  it("could-not-ask is its own answer, never 'not held'", async () => {
    answer(502, { error: "Failed to read payment outlook" });
    expect(await readPaymentHold(ORG)).toEqual({ ok: false, detail: "billing responded 502" });

    answer(200, { nothing: true });
    expect((await readPaymentHold(ORG)).ok).toBe(false);

    answer(200, { chargeBlocked: true, blockedReason: null });
    expect((await readPaymentHold(ORG)).ok).toBe(false);

    global.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await readPaymentHold(ORG)).toEqual({ ok: false, detail: "ECONNREFUSED" });

    delete process.env.BILLING_SERVICE_URL;
    expect(await readPaymentHold(ORG)).toEqual({ ok: false, detail: "billing not configured" });
  });
});

describe("paymentStartRefusal — what a person pressing start is told", () => {
  beforeEach(() => {
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("allows a start when billing can charge the org", async () => {
    answer(200, { chargeBlocked: false, blockedReason: null });
    expect(await paymentStartRefusal(ORG)).toBeNull();
  });

  it("refuses a declined card with 409 payment_declined and a sentence to render", async () => {
    answer(200, { chargeBlocked: true, blockedReason: "card_declined" });
    const refusal = await paymentStartRefusal(ORG);
    expect(refusal?.status).toBe(409);
    expect(refusal?.body).toMatchObject({ reason: "payment_declined", blockedReason: "card_declined" });
    expect(refusal?.body.error).toContain("card was declined");
    expect(refusal?.body.error).not.toContain("—");
  });

  it("names the unsupported issuing country in its own words", async () => {
    answer(200, { chargeBlocked: true, blockedReason: "card_country_unsupported" });
    const refusal = await paymentStartRefusal(ORG);
    expect(refusal?.status).toBe(409);
    expect(refusal?.body.error).toContain("issuing country");
  });

  it("refuses an org with NO payment method with 409 no_payment_method, and never says declined", async () => {
    answer(200, { chargeBlocked: true, blockedReason: "no_chargeable_card" });
    const refusal = await paymentStartRefusal(ORG);
    expect(refusal?.status).toBe(409);
    expect(refusal?.body).toMatchObject({ reason: "no_payment_method", blockedReason: "no_chargeable_card" });
    expect(refusal?.body.error).toContain("no payment method");
    expect(refusal?.body.error).toContain("Add a card");
    expect(refusal?.body.error).not.toContain("declined");
    expect(refusal?.body.error).not.toContain("—");
  });

  it.each(["card_declined", "card_unusable", "retries_exhausted", "card_country_unsupported", "some_future_reason"])(
    "keeps every other blocked reason (%s) on payment_declined, unchanged",
    async (blockedReason) => {
      answer(200, { chargeBlocked: true, blockedReason });
      const refusal = await paymentStartRefusal(ORG);
      expect(refusal?.status).toBe(409);
      expect(refusal?.body).toMatchObject({ reason: "payment_declined", blockedReason });
    },
  );

  it("fails CLOSED when billing cannot be read: nothing starts, 502 billing_unavailable", async () => {
    answer(503, {});
    const refusal = await paymentStartRefusal(ORG);
    expect(refusal?.status).toBe(502);
    expect(refusal?.body.reason).toBe("billing_unavailable");
  });
});

describe("paymentStopReason — which of the two payment stops", () => {
  it("maps no_chargeable_card to no_payment_method and everything else to payment_declined", () => {
    expect(paymentStopReason("no_chargeable_card")).toBe("no_payment_method");
    expect(paymentStopReason("card_declined")).toBe("payment_declined");
    expect(paymentStopReason("card_country_unsupported")).toBe("payment_declined");
    expect(paymentStopReason("retries_exhausted")).toBe("payment_declined");
  });
});
