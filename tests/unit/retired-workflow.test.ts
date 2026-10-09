import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockWhere, mockLiveDynasty } = vi.hoisted(() => ({
  mockWhere: vi.fn(),
  mockLiveDynasty: vi.fn(),
}));

vi.mock("../../src/db/index.js", () => ({
  db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: mockWhere })) })) },
}));

vi.mock("../../src/lib/startable-workflow-client.js", () => ({
  fetchLiveDynastyOtherThan: mockLiveDynasty,
}));

import { replaceRetiredWorkflow } from "../../src/lib/retired-workflow.js";
import { WorkflowExecutionRefusedError, isRetiredWorkflowRefusal } from "../../src/lib/workflow-refusal.js";

const refusal = (status: number, workflowSlug: string, body: unknown) =>
  new WorkflowExecutionRefusedError({ workflowSlug, campaignId: "c1", status, body: typeof body === "string" ? body : JSON.stringify(body) });

const ctx = {
  campaignId: "c1",
  storedSlug: "wf-rudder",
  featureSlug: "sales-cold-email-outreach",
  identity: { orgId: "o", userId: "u", runId: "r" },
};

describe("WorkflowExecutionRefusedError", () => {
  it("keeps the message every log line already greps for", () => {
    const err = refusal(410, "wf-rudder", { error: "Workflow has been deprecated", upgradedToWorkflowSlug: null });
    expect(err.message).toMatch(/Execution of "wf-rudder" for campaign c1 was refused \(410\): .*deprecated/);
    expect(err.upgradedToWorkflowSlug).toBeNull();
    expect(isRetiredWorkflowRefusal(err)).toBe(true);
  });

  it("reads a named successor, and a non-JSON body names none", () => {
    expect(refusal(410, "a", { upgradedToWorkflowSlug: "b" }).upgradedToWorkflowSlug).toBe("b");
    expect(refusal(410, "a", "<html>").upgradedToWorkflowSlug).toBeNull();
  });

  it("only a 410 is a retired workflow", () => {
    expect(isRetiredWorkflowRefusal(refusal(404, "a", "not found"))).toBe(false);
    expect(isRetiredWorkflowRefusal(new Error("refused (410)"))).toBe(false);
  });
});

describe("replaceRetiredWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockResolvedValue(undefined);
  });

  it("does nothing for a refusal that is not a 410", async () => {
    expect(await replaceRetiredWorkflow(refusal(500, "wf-rudder", "boom"), ctx)).toBeNull();
    expect(mockLiveDynasty).not.toHaveBeenCalled();
    expect(mockWhere).not.toHaveBeenCalled();
  });

  it("replaces the stored fallback with workflow-service's named successor", async () => {
    const next = await replaceRetiredWorkflow(refusal(410, "wf-rudder", { upgradedToWorkflowSlug: "wf-rudder-v2" }), ctx);
    expect(next).toBe("wf-rudder-v2");
    expect(mockLiveDynasty).not.toHaveBeenCalled();
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });

  it("asks for a live dynasty other than the dead one when no successor is named", async () => {
    mockLiveDynasty.mockResolvedValue({ ok: true, workflowSlug: "wf-compass" });
    const next = await replaceRetiredWorkflow(refusal(410, "wf-rudder", { upgradedToWorkflowSlug: null }), ctx);
    expect(next).toBe("wf-compass");
    expect(mockLiveDynasty).toHaveBeenCalledWith("sales-cold-email-outreach", "wf-rudder", ctx.identity);
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });

  it("leaves the stored fallback alone when the dead slug was a selector pick", async () => {
    mockLiveDynasty.mockResolvedValue({ ok: true, workflowSlug: "wf-compass" });
    const next = await replaceRetiredWorkflow(refusal(410, "wf-other", {}), ctx);
    expect(next).toBe("wf-compass");
    expect(mockWhere).not.toHaveBeenCalled();
  });

  it("names no successor when the channel has no live workflow, or it cannot be read", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLiveDynasty.mockResolvedValueOnce({ ok: true, workflowSlug: null });
    expect(await replaceRetiredWorkflow(refusal(410, "wf-rudder", {}), ctx)).toBeNull();
    mockLiveDynasty.mockResolvedValueOnce({ ok: false, detail: "HTTP 502" });
    expect(await replaceRetiredWorkflow(refusal(410, "wf-rudder", {}), ctx)).toBeNull();
    expect(mockWhere).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});
