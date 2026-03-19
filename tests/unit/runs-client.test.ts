import { describe, it, expect, beforeEach, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { createRun } from "@mcpfactory/runs-client";

describe("runs-client createRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-1" }),
    });
  });

  it("should send brandId, campaignId, workflowName as headers, not in body", async () => {
    await createRun({
      orgId: "org-1",
      userId: "user-1",
      serviceName: "campaign-service",
      taskName: "test-task",
      brandId: "brand-1",
      campaignId: "campaign-1",
      workflowName: "sales-email-cold-outreach",
      parentRunId: "parent-run-1",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];

    expect(url).toContain("/v1/runs");
    expect(options.method).toBe("POST");

    // Headers should contain tracking fields
    expect(options.headers["x-org-id"]).toBe("org-1");
    expect(options.headers["x-user-id"]).toBe("user-1");
    expect(options.headers["x-run-id"]).toBe("parent-run-1");
    expect(options.headers["x-brand-id"]).toBe("brand-1");
    expect(options.headers["x-campaign-id"]).toBe("campaign-1");
    expect(options.headers["x-workflow-name"]).toBe("sales-email-cold-outreach");

    // Body should only contain serviceName and taskName
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      serviceName: "campaign-service",
      taskName: "test-task",
    });
    expect(body).not.toHaveProperty("brandId");
    expect(body).not.toHaveProperty("campaignId");
    expect(body).not.toHaveProperty("workflowName");
  });

  it("should omit undefined tracking headers", async () => {
    await createRun({
      orgId: "org-1",
      serviceName: "campaign-service",
      taskName: "test-task",
    });

    const [, options] = mockFetch.mock.calls[0];

    expect(options.headers).not.toHaveProperty("x-brand-id");
    expect(options.headers).not.toHaveProperty("x-campaign-id");
    expect(options.headers).not.toHaveProperty("x-workflow-name");
    expect(options.headers).not.toHaveProperty("x-user-id");
    expect(options.headers).not.toHaveProperty("x-run-id");
  });
});
