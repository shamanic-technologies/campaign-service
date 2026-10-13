import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecute, mockPlan } = vi.hoisted(() => ({ mockExecute: vi.fn(), mockPlan: vi.fn() }));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(async () => ({ id: crypto.randomUUID() })),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getStatsBudget: vi.fn(),
}));

vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return {
    ...original,
    resolveSelectionForTrigger: vi.fn(async (a: { fallbackSlug: string }) => ({ workflowSlug: a.fallbackSlug, audienceId: null })),
  };
});

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});

vi.mock("../../src/lib/startable-pair.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/startable-pair.js")>();
  return { ...original, resolveSalesFunnelPlan: mockPlan };
});

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, salesFunnelCampaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { insertSalesFunnelUnits } from "../../src/lib/campaign-status-history.js";

/**
 * LEAK-1012 part 2: a sales funnel campaign states WHICH audiences it works, and every unit of it carries
 * them (the hard subset lead-service and the bandit read on `campaigns.audience_ids`).
 */
const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000a1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000a2";
const OFFER = "231bb036-0000-4000-8000-0000000000a3";
const CRM = "sourcing-crm-contacts";
const SOURCE_LEG = "start_to_lead_found";
const EMAIL = "sales-cold-email-outreach";
const ENTRY = "lead_found_to_conversation";
const WORLDLY = `${SOURCE_LEG}@${CRM}+${ENTRY}@${EMAIL}`;
const VALUED = `${SOURCE_LEG}@${CRM}+${ENTRY}@sales-cold-whatsapp-outreach`;
const EMAIL_AUDIENCE = "297ac32a-f9be-485c-91dd-c6f852ae9b93";
const WHATSAPP_AUDIENCE = "813fbac4-8657-4fca-b914-44a44388bbed";

const withPerson = (r: request.Test) =>
  r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", "user_funnel").set("x-run-id", crypto.randomUUID());
const launch = (body: Record<string, unknown>) => withPerson(request(app).post("/sales-funnel-campaigns")).send(body);
const patchFunnel = (id: string, body: Record<string, unknown>) =>
  withPerson(request(app).patch(`/sales-funnel-campaigns/${id}`)).send(body);

function planOf(name: string) {
  return {
    ok: true,
    plan: {
      salesFunnelId: "unused",
      salesFunnelName: name,
      units: [
        { pipeId: `${CRM}|${SOURCE_LEG}`, featureSlug: CRM, legKey: SOURCE_LEG, mode: "proactive", workflowSlug: "crm-find-v1" },
        { pipeId: `${EMAIL}|${ENTRY}`, featureSlug: EMAIL, legKey: ENTRY, mode: "proactive", workflowSlug: "aurora-v3" },
      ],
    },
  };
}

async function unitAudiences(salesFunnelCampaignId: string) {
  const rows = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, salesFunnelCampaignId));
  return rows.map((u) => u.audienceIds);
}

describe("a sales funnel campaign's audiences (LEAK-1012)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockPlan.mockResolvedValue(planOf("Worldly"));
    mockExecute.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("a funnel launched with audiences hands them to EVERY unit (source and outreach) and serves them", async () => {
    const res = await launch({
      brandId: BRAND, offerId: OFFER, salesFunnelId: WORLDLY, status: "stopped",
      audienceIds: [EMAIL_AUDIENCE, ` ${EMAIL_AUDIENCE}`],
    }).expect(201);
    const fc = res.body.salesFunnelCampaign;
    expect(fc.audienceIds).toEqual([EMAIL_AUDIENCE]);
    expect(fc.units.map((u: { audienceIds: string[] | null }) => u.audienceIds)).toEqual([[EMAIL_AUDIENCE], [EMAIL_AUDIENCE]]);
    expect(await unitAudiences(fc.id)).toEqual([[EMAIL_AUDIENCE], [EMAIL_AUDIENCE]]);

    const read = await withPerson(request(app).get(`/sales-funnel-campaigns/${fc.id}`)).expect(200);
    expect(read.body.salesFunnelCampaign.audienceIds).toEqual([EMAIL_AUDIENCE]);
    expect(read.body.salesFunnelCampaign.units.every((u: { audienceIds: string[] }) => u.audienceIds[0] === EMAIL_AUDIENCE)).toBe(true);
  });

  it("a funnel launched naming none leaves its units on the brand's audiences (null), as before", async () => {
    const res = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: WORLDLY, status: "stopped" }).expect(201);
    expect(res.body.salesFunnelCampaign.audienceIds).toBeNull();
    expect(await unitAudiences(res.body.salesFunnelCampaign.id)).toEqual([null, null]);
  });

  it("restating on the funnel restates every unit, status untouched; null clears; an empty list is refused", async () => {
    const created = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: WORLDLY, status: "stopped" }).expect(201);
    const id = created.body.salesFunnelCampaign.id;

    const set = await patchFunnel(id, { audienceIds: [EMAIL_AUDIENCE] }).expect(200);
    expect(set.body.salesFunnelCampaign).toMatchObject({ status: "stopped", audienceIds: [EMAIL_AUDIENCE] });
    expect(await unitAudiences(id)).toEqual([[EMAIL_AUDIENCE], [EMAIL_AUDIENCE]]);
    const units = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, id));
    expect(units.every((u) => u.status === "stopped")).toBe(true);
    expect(mockExecute).not.toHaveBeenCalled();

    await patchFunnel(id, { audienceIds: [] }).expect(400);

    const cleared = await patchFunnel(id, { audienceIds: null }).expect(200);
    expect(cleared.body.salesFunnelCampaign.audienceIds).toBeNull();
    expect(await unitAudiences(id)).toEqual([null, null]);
  });

  it("restates audiences together with a start: the started units carry them", async () => {
    const created = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: WORLDLY, status: "stopped" }).expect(201);
    const id = created.body.salesFunnelCampaign.id;
    const on = await patchFunnel(id, { status: "activate", audienceIds: [EMAIL_AUDIENCE] }).expect(200);
    expect(on.body.salesFunnelCampaign).toMatchObject({ status: "ongoing", audienceIds: [EMAIL_AUDIENCE] });
    expect(on.body.salesFunnelCampaign.units.map((u: { audienceIds: string[] }) => u.audienceIds)).toEqual([[EMAIL_AUDIENCE], [EMAIL_AUDIENCE]]);
  });

  it("a launch handed back with other audiences restates them; without audiences leaves them", async () => {
    const created = await launch({
      brandId: BRAND, offerId: OFFER, salesFunnelId: WORLDLY, status: "stopped", audienceIds: [EMAIL_AUDIENCE],
    }).expect(201);
    const id = created.body.salesFunnelCampaign.id;

    const same = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: WORLDLY, status: "stopped" }).expect(200);
    expect(same.body.salesFunnelCampaign).toMatchObject({ id, audienceIds: [EMAIL_AUDIENCE] });

    const restated = await launch({
      brandId: BRAND, offerId: OFFER, salesFunnelId: WORLDLY, status: "stopped", audienceIds: [WHATSAPP_AUDIENCE],
    }).expect(200);
    expect(restated.body.salesFunnelCampaign).toMatchObject({ id, status: "stopped", audienceIds: [WHATSAPP_AUDIENCE] });
    expect(await unitAudiences(id)).toEqual([[WHATSAPP_AUDIENCE], [WHATSAPP_AUDIENCE]]);
  });

  it("a unit born LATER into the funnel campaign carries its audiences", async () => {
    const created = await launch({
      brandId: BRAND, offerId: OFFER, salesFunnelId: WORLDLY, status: "stopped", audienceIds: [EMAIL_AUDIENCE],
    }).expect(201);
    const id = created.body.salesFunnelCampaign.id;
    const [parent] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, id));
    const [late] = await db.transaction((tx) =>
      insertSalesFunnelUnits(tx, parent, [
        { featureSlug: "lead-sourcing", legKey: SOURCE_LEG, workflowSlug: null, acquisitionChannel: "lead-sourcing", name: "Worldly late unit" },
      ]),
    );
    expect(late.audienceIds).toEqual([EMAIL_AUDIENCE]);
  });

  it("a unit's audiences are its funnel campaign's: PATCH /campaigns/:id stating them is refused", async () => {
    const created = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: WORLDLY, status: "stopped" }).expect(201);
    const unitId = created.body.salesFunnelCampaign.units[0].campaignId;
    const res = await withPerson(request(app).patch(`/campaigns/${unitId}`)).send({ audienceIds: [EMAIL_AUDIENCE] }).expect(409);
    expect(res.body).toMatchObject({ reason: "sales_funnel_unit", salesFunnelCampaignId: created.body.salesFunnelCampaign.id });
  });

  it("two funnels of one offer on the same source each work only their own audiences", async () => {
    const worldly = await launch({
      brandId: BRAND, offerId: OFFER, salesFunnelId: WORLDLY, status: "stopped", audienceIds: [EMAIL_AUDIENCE],
    }).expect(201);
    mockPlan.mockResolvedValue(planOf("Valued"));
    const valued = await launch({
      brandId: BRAND, offerId: OFFER, salesFunnelId: VALUED, status: "stopped", audienceIds: [WHATSAPP_AUDIENCE],
    }).expect(201);
    expect(await unitAudiences(worldly.body.salesFunnelCampaign.id)).toEqual([[EMAIL_AUDIENCE], [EMAIL_AUDIENCE]]);
    expect(await unitAudiences(valued.body.salesFunnelCampaign.id)).toEqual([[WHATSAPP_AUDIENCE], [WHATSAPP_AUDIENCE]]);
  });

  it("a second funnel naming NO audience on a source another funnel of the offer runs is said loudly, not refused", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: WORLDLY, status: "stopped", audienceIds: [EMAIL_AUDIENCE] }).expect(201);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("names NO audience"))).toBe(false);
    mockPlan.mockResolvedValue(planOf("Valued"));
    await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: VALUED, status: "stopped" }).expect(201);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("names NO audience") && String(c[0]).includes(CRM))).toBe(true);
    errors.mockRestore();
  });
});
