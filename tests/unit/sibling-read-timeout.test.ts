import { describe, it, expect, afterEach, vi } from "vitest";

// FLEET-STALL-1107: a sibling read that never answers must come back as "could not be read" within
// its deadline, so the caller's own fail-soft / fail-open / fail-closed answer applies at once
// instead of holding the scheduler tick (prod 2026-11-07: ~40 min, every client's dispatch at ~0).
vi.mock("../../src/lib/sibling-read-timeout.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sibling-read-timeout.js")>();
  return { ...original, siblingReadSignal: () => AbortSignal.timeout(50) };
});

const { readPaymentHold } = await vi.importActual<typeof import("../../src/lib/payment-hold.js")>(
  "../../src/lib/payment-hold.js",
);
const { SIBLING_READ_TIMEOUT_MS } = await vi.importActual<typeof import("../../src/lib/sibling-read-timeout.js")>(
  "../../src/lib/sibling-read-timeout.js",
);

const originalFetch = global.fetch;

/** A sibling that never answers: the call ends only when its signal aborts. */
function siblingHangs() {
  global.fetch = vi.fn((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no deadline = hangs forever (the bug)
      signal.addEventListener("abort", () => reject(signal.reason));
    }),
  ) as unknown as typeof fetch;
}

describe("a sibling read that never answers is a bounded 'could not be read'", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("the deadline is seconds, never the 300 s fetch would wait on its own", () => {
    expect(SIBLING_READ_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SIBLING_READ_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it("billing's payment-outlook hanging = unreadable within the deadline (the sweep leaves the org as is, a run is allowed)", async () => {
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
    siblingHangs();
    const started = Date.now();
    const read = await readPaymentHold("81b34252-61e3-47b5-9293-5294b6fb51b6");
    expect(read.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
