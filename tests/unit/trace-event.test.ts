import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { traceEvent } from "../../src/lib/trace-event.js";

describe("traceEvent", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.RUNS_SERVICE_URL = "https://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs event to runs-service with correct URL and payload", async () => {
    const headers = {
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-campaign-id": "camp-1",
    };

    await traceEvent("run-123", {
      service: "campaign-service",
      event: "create-campaign",
      detail: "Created campaign test-camp",
      level: "info",
      data: { name: "test-camp" },
    }, headers);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://runs.test/v1/runs/run-123/events");
    expect(opts.method).toBe("POST");
    expect(opts.headers["x-api-key"]).toBe("test-key");
    expect(opts.headers["x-org-id"]).toBe("org-1");
    expect(opts.headers["x-user-id"]).toBe("user-1");
    expect(opts.headers["x-campaign-id"]).toBe("camp-1");
    expect(opts.headers["x-brand-id"]).toBeUndefined();

    const body = JSON.parse(opts.body);
    expect(body.service).toBe("campaign-service");
    expect(body.event).toBe("create-campaign");
    expect(body.detail).toBe("Created campaign test-camp");
    expect(body.level).toBe("info");
    expect(body.data).toEqual({ name: "test-camp" });
  });

  it("skips when RUNS_SERVICE_URL is not set", async () => {
    delete process.env.RUNS_SERVICE_URL;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await traceEvent("run-123", { service: "campaign-service", event: "test" }, {});

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not set"),
    );
    consoleSpy.mockRestore();
  });

  it("does not throw on fetch failure", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      traceEvent("run-123", { service: "campaign-service", event: "test" }, {}),
    ).resolves.toBeUndefined();

    consoleSpy.mockRestore();
  });

  it("forwards only present identity headers", async () => {
    const headers = { "x-org-id": "org-1", "x-feature-slug": "cold-email" };

    await traceEvent("run-123", { service: "campaign-service", event: "test" }, headers);

    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.headers["x-org-id"]).toBe("org-1");
    expect(opts.headers["x-feature-slug"]).toBe("cold-email");
    expect(opts.headers["x-user-id"]).toBeUndefined();
    expect(opts.headers["x-campaign-id"]).toBeUndefined();
  });
});
