import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  getWorkflowDynastyMap,
  getFeatureDynastyMap,
} from "../../src/lib/dynasty-client.js";

describe("dynasty-client", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      WORKFLOW_SERVICE_URL: "https://workflow.test",
      WORKFLOW_SERVICE_API_KEY: "wf-key",
      FEATURES_SERVICE_URL: "https://features.test",
      FEATURES_SERVICE_API_KEY: "feat-key",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveWorkflowDynastySlugs", () => {
    it("should resolve dynasty slug to versioned slugs", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ slugs: ["cold-email", "cold-email-v2", "cold-email-v3"] }),
      });

      const result = await resolveWorkflowDynastySlugs("cold-email");

      expect(result).toEqual(["cold-email", "cold-email-v2", "cold-email-v3"]);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://workflow.test/workflows/dynasty/slugs?dynastySlug=cold-email",
        { headers: { "x-api-key": "wf-key" } },
      );
    });

    it("should throw when env vars are missing", async () => {
      delete process.env.WORKFLOW_SERVICE_URL;
      await expect(resolveWorkflowDynastySlugs("x")).rejects.toThrow("not configured");
    });

    it("should throw on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(resolveWorkflowDynastySlugs("x")).rejects.toThrow("500");
    });
  });

  describe("resolveFeatureDynastySlugs", () => {
    it("should resolve dynasty slug to versioned slugs", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ slugs: ["feat-alpha", "feat-alpha-v2"] }),
      });

      const result = await resolveFeatureDynastySlugs("feat-alpha");

      expect(result).toEqual(["feat-alpha", "feat-alpha-v2"]);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://features.test/features/dynasty/slugs?dynastySlug=feat-alpha",
        { headers: { "x-api-key": "feat-key" } },
      );
    });

    it("should throw when env vars are missing", async () => {
      delete process.env.FEATURES_SERVICE_URL;
      await expect(resolveFeatureDynastySlugs("x")).rejects.toThrow("not configured");
    });

    it("should throw on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      await expect(resolveFeatureDynastySlugs("x")).rejects.toThrow("404");
    });
  });

  describe("getWorkflowDynastyMap", () => {
    it("should build reverse map from dynasties", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          dynasties: [
            { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
            { dynastySlug: "warm-intro", slugs: ["warm-intro", "warm-intro-v2", "warm-intro-v3"] },
          ],
        }),
      });

      const map = await getWorkflowDynastyMap();

      expect(map.get("cold-email")).toBe("cold-email");
      expect(map.get("cold-email-v2")).toBe("cold-email");
      expect(map.get("warm-intro-v3")).toBe("warm-intro");
      expect(map.get("unknown")).toBeUndefined();
    });

    it("should throw when env vars are missing", async () => {
      delete process.env.WORKFLOW_SERVICE_API_KEY;
      await expect(getWorkflowDynastyMap()).rejects.toThrow("not configured");
    });
  });

  describe("getFeatureDynastyMap", () => {
    it("should build reverse map from dynasties", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          dynasties: [
            { dynastySlug: "feat-alpha", slugs: ["feat-alpha", "feat-alpha-v2"] },
          ],
        }),
      });

      const map = await getFeatureDynastyMap();

      expect(map.get("feat-alpha")).toBe("feat-alpha");
      expect(map.get("feat-alpha-v2")).toBe("feat-alpha");
    });

    it("should throw when env vars are missing", async () => {
      delete process.env.FEATURES_SERVICE_URL;
      await expect(getFeatureDynastyMap()).rejects.toThrow("not configured");
    });
  });
});
