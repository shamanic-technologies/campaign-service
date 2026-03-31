import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { arrayContains } from "drizzle-orm/sql/expressions/conditions";
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

    it("should create a campaign with brandIds", async () => {
      const brandId = crypto.randomUUID();
      const campaign = await insertTestCampaign("org_1", {
        name: "Brand Campaign",
        brandIds: [brandId],
      });

      expect(campaign.brandIds).toEqual([brandId]);
    });

    it("should store null brandIds when explicitly set to undefined", async () => {
      const campaign = await insertTestCampaign("org_1", {
        name: "No Brand Campaign",
        brandIds: undefined,
      });

      expect(campaign.brandIds).toBeNull();
    });

    it("should query campaigns by brandIds", async () => {
      const brandId = crypto.randomUUID();
      await insertTestCampaign("org_1", { name: "With Brand", brandIds: [brandId] });
      await insertTestCampaign("org_1", { name: "Without Brand", brandIds: undefined });

      const results = await db
        .select()
        .from(campaigns)
        .where(arrayContains(campaigns.brandIds, [brandId]));

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("With Brand");
      expect(results[0].brandIds).toEqual([brandId]);
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
