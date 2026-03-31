import { describe, it, expect } from "vitest";
import { trackingHeaders, parseBrandIdHeader, type AuthenticatedRequest } from "../../src/middleware/auth.js";
import type { Response, NextFunction } from "express";

function createMockReq(headers: Record<string, string> = {}): AuthenticatedRequest {
  return {
    headers,
  } as unknown as AuthenticatedRequest;
}

describe("trackingHeaders middleware", () => {
  it("should read x-campaign-id, x-brand-id (single), x-workflow-slug from headers", () => {
    const req = createMockReq({
      "x-campaign-id": "camp-123",
      "x-brand-id": "brand-456",
      "x-workflow-slug": "sales-email-cold-outreach",
    });

    let nextCalled = false;
    trackingHeaders(req, {} as Response, (() => { nextCalled = true; }) as NextFunction);

    expect(req.campaignId).toBe("camp-123");
    expect(req.brandIds).toEqual(["brand-456"]);
    expect(req.workflowSlug).toBe("sales-email-cold-outreach");
    expect(nextCalled).toBe(true);
  });

  it("should parse x-brand-id as CSV with multiple UUIDs", () => {
    const req = createMockReq({
      "x-brand-id": "uuid1,uuid2,uuid3",
    });

    trackingHeaders(req, {} as Response, (() => {}) as NextFunction);

    expect(req.brandIds).toEqual(["uuid1", "uuid2", "uuid3"]);
  });

  it("should trim whitespace in CSV brand IDs", () => {
    const req = createMockReq({
      "x-brand-id": " uuid1 , uuid2 , uuid3 ",
    });

    trackingHeaders(req, {} as Response, (() => {}) as NextFunction);

    expect(req.brandIds).toEqual(["uuid1", "uuid2", "uuid3"]);
  });

  it("should read x-feature-slug from headers", () => {
    const req = createMockReq({
      "x-feature-slug": "sales-cold-email-v1",
      "x-campaign-id": "camp-123",
    });

    trackingHeaders(req, {} as Response, (() => {}) as NextFunction);

    expect(req.featureSlug).toBe("sales-cold-email-v1");
    expect(req.campaignId).toBe("camp-123");
  });

  it("should not set properties when headers are absent", () => {
    const req = createMockReq({});

    let nextCalled = false;
    trackingHeaders(req, {} as Response, (() => { nextCalled = true; }) as NextFunction);

    expect(req.campaignId).toBeUndefined();
    expect(req.brandIds).toBeUndefined();
    expect(req.workflowSlug).toBeUndefined();
    expect(req.featureSlug).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it("should handle partial headers", () => {
    const req = createMockReq({
      "x-campaign-id": "camp-789",
    });

    trackingHeaders(req, {} as Response, (() => {}) as NextFunction);

    expect(req.campaignId).toBe("camp-789");
    expect(req.brandIds).toBeUndefined();
    expect(req.workflowSlug).toBeUndefined();
  });
});

describe("parseBrandIdHeader", () => {
  it("should parse single UUID", () => {
    expect(parseBrandIdHeader("550e8400-e29b-41d4-a716-446655440000")).toEqual([
      "550e8400-e29b-41d4-a716-446655440000",
    ]);
  });

  it("should parse multiple comma-separated UUIDs", () => {
    expect(parseBrandIdHeader("uuid1,uuid2,uuid3")).toEqual(["uuid1", "uuid2", "uuid3"]);
  });

  it("should trim whitespace", () => {
    expect(parseBrandIdHeader(" uuid1 , uuid2 ")).toEqual(["uuid1", "uuid2"]);
  });

  it("should return empty array for undefined", () => {
    expect(parseBrandIdHeader(undefined)).toEqual([]);
  });

  it("should return empty array for empty string", () => {
    expect(parseBrandIdHeader("")).toEqual([]);
  });

  it("should filter out empty segments", () => {
    expect(parseBrandIdHeader("uuid1,,uuid2,")).toEqual(["uuid1", "uuid2"]);
  });
});
