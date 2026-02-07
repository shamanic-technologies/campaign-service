import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { orgs, campaigns } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestOrg, insertTestCampaign } from "../helpers/test-db.js";

describe("Campaign Service Database", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("orgs table", () => {
    it("should create and query an org", async () => {
      const org = await insertTestOrg({ clerkOrgId: "org_test123" });

      expect(org.id).toBeDefined();
      expect(org.clerkOrgId).toBe("org_test123");

      const found = await db.query.orgs.findFirst({
        where: eq(orgs.id, org.id),
      });
      expect(found?.clerkOrgId).toBe("org_test123");
    });
  });

  describe("campaigns table", () => {
    it("should create a campaign linked to org", async () => {
      const org = await insertTestOrg();
      const campaign = await insertTestCampaign(org.id, {
        name: "Test Campaign",
        status: "active",
      });

      expect(campaign.id).toBeDefined();
      expect(campaign.name).toBe("Test Campaign");
      expect(campaign.status).toBe("active");
    });

    it("should create a campaign with appId", async () => {
      const org = await insertTestOrg();
      const appId = crypto.randomUUID();
      const campaign = await insertTestCampaign(org.id, {
        name: "App Campaign",
        appId,
      });

      expect(campaign.appId).toBe(appId);
    });

    it("should store null appId when not provided", async () => {
      const org = await insertTestOrg();
      const campaign = await insertTestCampaign(org.id, {
        name: "No App Campaign",
      });

      expect(campaign.appId).toBeNull();
    });

    it("should query campaign and return appId column", async () => {
      const org = await insertTestOrg();
      const appId = crypto.randomUUID();
      await insertTestCampaign(org.id, { name: "Queryable", appId });

      const found = await db.query.campaigns.findFirst({
        where: eq(campaigns.orgId, org.id),
      });

      expect(found).toBeDefined();
      expect(found!.appId).toBe(appId);
    });

    it("should select all campaigns with appId column present", async () => {
      const org = await insertTestOrg();
      const appId = crypto.randomUUID();
      await insertTestCampaign(org.id, { name: "Select Test", appId });

      const results = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.orgId, org.id));

      expect(results).toHaveLength(1);
      expect(results[0].appId).toBe(appId);
    });

    it("should cascade delete when org is deleted", async () => {
      const org = await insertTestOrg();
      const campaign = await insertTestCampaign(org.id);

      await db.delete(orgs).where(eq(orgs.id, org.id));

      const found = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(found).toBeUndefined();
    });
  });
});
