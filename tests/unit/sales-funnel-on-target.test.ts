import { describe, it, expect } from "vitest";
import { runsOnItsTarget } from "../../src/lib/sales-funnel-on-target.js";

const FUNNEL = "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking";
const pipeUnit = { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowSlug: "cold-email-wf" };
const engineUnit = (outcome: string) => ({ featureSlug: null, legKey: null, workflowSlug: `engine:${outcome}` });

describe("runsOnItsTarget (PLAN-RECURSIVE-PER-ENGINE-1124-CS)", () => {
  it("a campaign launched on its target alone runs on it, whatever its units", () => {
    expect(runsOnItsTarget({ target: "backlink_earned", salesFunnelId: "backlink_earned" }, [])).toBe(true);
  });

  it("a funnel campaign moved onto its target: it keeps its funnel id and owns an Engine unit of its target", () => {
    expect(runsOnItsTarget({ target: "meeting_booked", salesFunnelId: FUNNEL }, [pipeUnit, engineUnit("meeting_booked")])).toBe(true);
  });

  it("an Engine unit of ANOTHER outcome does not count", () => {
    expect(runsOnItsTarget({ target: "meeting_booked", salesFunnelId: FUNNEL }, [pipeUnit, engineUnit("paid_client")])).toBe(false);
  });

  it("no Engine unit: it runs its pipes", () => {
    expect(runsOnItsTarget({ target: "meeting_booked", salesFunnelId: FUNNEL }, [pipeUnit])).toBe(false);
    expect(runsOnItsTarget({ target: "meeting_booked", salesFunnelId: FUNNEL }, [])).toBe(false);
  });

  it("a unit on a channel is never an Engine unit, even on an engine slug; no target = never", () => {
    expect(runsOnItsTarget({ target: "meeting_booked", salesFunnelId: FUNNEL }, [{ ...pipeUnit, workflowSlug: "engine:meeting_booked" }])).toBe(false);
    expect(runsOnItsTarget({ target: null, salesFunnelId: FUNNEL }, [engineUnit("meeting_booked")])).toBe(false);
  });
});
