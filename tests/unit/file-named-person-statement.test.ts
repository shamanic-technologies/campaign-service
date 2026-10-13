import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileNamedPerson } from "../../src/lib/sales-funnel-people.js";

/** What campaign-service sends lead-service's named-person door, and how it reads the refusals. */
describe("fileNamedPerson: the brand's statement rides the filing", () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let answer: { status: number; body: unknown } = { status: 201, body: { leadId: "lead-1", status: "filed" } };

  beforeEach(() => {
    process.env.LEAD_SERVICE_URL = "http://lead:3000";
    process.env.LEAD_SERVICE_API_KEY = "k";
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("without a statement the body is exactly the email, as before", async () => {
    answer = { status: 201, body: { leadId: "lead-1", status: "filed" } };
    await fileNamedPerson({ orgId: "o", campaignId: "c", email: "a@x.com", name: "Ada" });
    expect(calls[0].body).toEqual({ email: "a@x.com" });
  });

  it("with a statement it sends statedBy and the name", async () => {
    answer = { status: 201, body: { leadId: "lead-1", status: "filed" } };
    const out = await fileNamedPerson({
      orgId: "o",
      campaignId: "c",
      email: "a@x.com",
      statedBy: { triggerEventId: "evt-1", triggerId: "email_pushed_via_api" },
      name: "Ada Lovelace",
    });
    expect(out).toEqual({ ok: true, leadId: "lead-1", filed: true });
    expect(calls[0].url).toBe("http://lead:3000/orgs/campaigns/c/leads/by-email");
    expect(calls[0].body).toEqual({
      email: "a@x.com",
      statedBy: { triggerEventId: "evt-1", triggerId: "email_pushed_via_api" },
      name: "Ada Lovelace",
    });
  });

  it("names a suppressed person person_suppressed", async () => {
    answer = { status: 409, body: { code: "person_suppressed", reason: "unsubscribed" } };
    const out = await fileNamedPerson({ orgId: "o", campaignId: "c", email: "a@x.com", statedBy: { triggerEventId: "e" } });
    expect(out).toMatchObject({ ok: false, code: "person_suppressed" });
    expect(out.ok ? "" : out.detail).toContain("unsubscribed");
  });
});
