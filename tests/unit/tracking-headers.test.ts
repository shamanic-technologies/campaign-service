import { describe, it, expect } from "vitest";
import { trackingHeaders, type AuthenticatedRequest } from "../../src/middleware/auth.js";
import type { Response, NextFunction } from "express";

function createMockReq(headers: Record<string, string> = {}): AuthenticatedRequest {
  return {
    headers,
  } as unknown as AuthenticatedRequest;
}

describe("trackingHeaders middleware", () => {
  it("should read x-campaign-id, x-brand-id, x-workflow-name from headers", () => {
    const req = createMockReq({
      "x-campaign-id": "camp-123",
      "x-brand-id": "brand-456",
      "x-workflow-name": "sales-email-cold-outreach",
    });

    let nextCalled = false;
    trackingHeaders(req, {} as Response, (() => { nextCalled = true; }) as NextFunction);

    expect(req.campaignId).toBe("camp-123");
    expect(req.brandId).toBe("brand-456");
    expect(req.workflowName).toBe("sales-email-cold-outreach");
    expect(nextCalled).toBe(true);
  });

  it("should not set properties when headers are absent", () => {
    const req = createMockReq({});

    let nextCalled = false;
    trackingHeaders(req, {} as Response, (() => { nextCalled = true; }) as NextFunction);

    expect(req.campaignId).toBeUndefined();
    expect(req.brandId).toBeUndefined();
    expect(req.workflowName).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it("should handle partial headers", () => {
    const req = createMockReq({
      "x-campaign-id": "camp-789",
    });

    trackingHeaders(req, {} as Response, (() => {}) as NextFunction);

    expect(req.campaignId).toBe("camp-789");
    expect(req.brandId).toBeUndefined();
    expect(req.workflowName).toBeUndefined();
  });
});
