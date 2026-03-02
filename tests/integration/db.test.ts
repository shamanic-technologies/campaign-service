import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

describe("Campaign Service Database", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("campaigns table", () => {
    it("should create a campaign with orgId stored directly", async () => {
      const campaign = await insertTestCampaign("org_test_123", {
        name: "Test Campaign",
        status: "ongoing",
      });

      expect(campaign.id).toBeDefined();
      expect(campaign.name).toBe("Test Campaign");
      expect(campaign.status).toBe("ongoing");
      expect(campaign.orgId).toBe("org_test_123");
    });

    it("should query campaigns by orgId", async () => {
      await insertTestCampaign("org_1", { name: "Org1 Campaign" });
      await insertTestCampaign("org_2", { name: "Org2 Campaign" });

      const results = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.orgId, "org_1"));

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Org1 Campaign");
    });

    it("should create a campaign with brandId", async () => {
      const brandId = crypto.randomUUID();
      const campaign = await insertTestCampaign("org_1", {
        name: "Brand Campaign",
        brandId,
      });

      expect(campaign.brandId).toBe(brandId);
    });

    it("should store null brandId when not provided", async () => {
      const campaign = await insertTestCampaign("org_1", {
        name: "No Brand Campaign",
      });

      expect(campaign.brandId).toBeNull();
    });

    it("should query campaigns by brandId", async () => {
      const brandId = crypto.randomUUID();
      await insertTestCampaign("org_1", { name: "With Brand", brandId });
      await insertTestCampaign("org_1", { name: "Without Brand" });

      const results = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.brandId, brandId));

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("With Brand");
      expect(results[0].brandId).toBe(brandId);
    });

    it("should not have appId or keySource columns", async () => {
      const campaign = await insertTestCampaign("org_1", {
        name: "No Legacy Fields",
      });

      expect(campaign).not.toHaveProperty("appId");
      expect(campaign).not.toHaveProperty("keySource");
    });
  });
});
