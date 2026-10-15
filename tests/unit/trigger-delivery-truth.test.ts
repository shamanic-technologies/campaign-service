import { describe, it, expect } from "vitest";
import { deliveryOf, runDelivered } from "../../src/lib/trigger-deliveries.js";
import { notMadeDue } from "../../src/lib/sales-funnel-people.js";
import { EndRunBody } from "../../src/schemas.js";

const carrying = { item: { subject: "s" } };
const row = (status: string, extra: Partial<{ refusalCode: string; refusalReason: string }> = {}) => ({
  campaignId: "c1",
  status,
  refusalCode: extra.refusalCode ?? null,
  refusalReason: extra.refusalReason ?? null,
});

describe("what a client reads about what an occurrence carried (PUSHED-TRUTH-1015)", () => {
  it("never says delivered for a refusal, a run in flight or a run nobody reported", () => {
    expect(deliveryOf({ status: "done", outcome: "refused", detail: carrying }, [row("refused", { refusalCode: "x", refusalReason: "why" })]))
      .toEqual({ state: "refused", refusals: [{ campaignId: "c1", code: "x", reason: "why" }] });
    expect(deliveryOf({ status: "done", outcome: "ran", detail: carrying }, [row("dispatched")])?.state).toBe("in_flight");
    expect(deliveryOf({ status: "done", outcome: "ran", detail: carrying }, [])?.state).toBe("unconfirmed");
    expect(deliveryOf({ status: "done", outcome: "ran", detail: carrying }, [row("failed"), row("completed")])?.state).toBe("delivered");
    expect(deliveryOf({ status: "pending", outcome: null, detail: carrying }, [row("failed")])?.state).toBe("owed");
    expect(deliveryOf({ status: "done", outcome: "failed", detail: carrying }, [row("failed")])?.state).toBe("failed");
    expect(deliveryOf({ status: "done", outcome: "skipped", detail: carrying }, [])?.state).toBe("skipped");
    expect(deliveryOf({ status: "done", outcome: "ran", detail: {} }, [])).toBeNull();
  });

  it("a stated refusal is never a delivered run, whatever success says", () => {
    expect(runDelivered({ success: true, delivery: { state: "refused", code: "x", reason: "y" } })).toBe(false);
    expect(runDelivered({ success: true, delivery: { state: "delivered" } })).toBe(true);
    expect(runDelivered({ success: true })).toBe(true);
    expect(runDelivered({ success: false })).toBe(false);
  });

  it("/end-run delivery is optional and validated", () => {
    expect(EndRunBody.safeParse({ success: true, stopCampaign: false }).success).toBe(true);
    expect(EndRunBody.safeParse({ success: true, stopCampaign: false, delivery: { state: "delivered" } }).success).toBe(true);
    expect(EndRunBody.safeParse({ success: true, stopCampaign: false, delivery: { state: "refused", code: "c", reason: "r" } }).success).toBe(true);
    expect(EndRunBody.safeParse({ success: true, stopCampaign: false, delivery: { state: "refused", code: "", reason: "r" } }).success).toBe(false);
    expect(EndRunBody.safeParse({ success: true, stopCampaign: false, delivery: { state: "sent" } }).success).toBe(false);
  });

  it("lead-service's 200 with no due date = not made due, its sentence kept", () => {
    expect(notMadeDue({ dueAt: "2026-10-15T10:00:00.000Z" })).toEqual({ ok: true });
    expect(notMadeDue(undefined)).toEqual({ ok: true });
    expect(notMadeDue({ dueAt: null, handedReason: "Handed to the brand's team", stoppedReason: "x" }))
      .toEqual({ ok: false, code: "person_not_due", detail: "Handed to the brand's team" });
    expect(notMadeDue({ dueAt: null, handedReason: null, stoppedReason: null }).ok).toBe(false);
  });
});
