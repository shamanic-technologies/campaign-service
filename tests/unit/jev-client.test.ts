import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { judgeNoul, platformCallerParts } from "../../src/lib/jev-client.js";

// PLATFORM-CALLER-RUN-1024: every chat-service platform call states its caller run (x-run-id) OR a support
// function (body `support`), exactly one.
describe("jev-client: whose work a platform judgment is", () => {
  const question = { type: "noul" as const, instructions: "q?" };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.CHAT_SERVICE_URL = "http://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "k";
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.9 } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a caller run rides x-run-id, no support in the body", async () => {
    const runId = "5e1f0c2a-0000-4000-8000-000000000045";
    expect(await judgeNoul({ a: 1 }, question, { runId })).toBe(0.9);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://chat.test/internal/platform-judgments");
    expect(init.headers["x-run-id"]).toBe(runId);
    expect(JSON.parse(init.body)).not.toHaveProperty("support");
  });

  it("a support function rides the body, no x-run-id", async () => {
    await judgeNoul({ a: 1 }, question, { support: { kind: "platform_llm", reason: "test" } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).not.toHaveProperty("x-run-id");
    expect(JSON.parse(init.body).support).toEqual({ kind: "platform_llm", reason: "test" });
  });

  it("stating neither throws before any call", async () => {
    expect(() => platformCallerParts({} as never)).toThrow(/caller run or a support function/);
    await expect(judgeNoul({}, question, {} as never)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
