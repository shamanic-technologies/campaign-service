import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaignAudienceAvailability } from "../../src/db/schema.js";
import { cleanTestData, closeDb, randomId } from "../helpers/test-db.js";
import { recordAudienceAvailability } from "../../src/lib/campaign-audience-availability.js";
import { claimEpisodeRefill } from "../../src/lib/audience-refill.js";

/**
 * ONE refill attempt per exhaustion episode. Every /end-run of a campaign that has nobody left
 * observes the same exhaustion; only the first may ask human-service to refill the brand.
 */
describe("claimEpisodeRefill", () => {
  const ORG = randomId();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("claims once per has_audience=false period, however many observations land", async () => {
    const campaignId = randomId();
    await recordAudienceAvailability(campaignId, ORG, false);
    await recordAudienceAvailability(campaignId, ORG, false);

    const claims = await Promise.all(Array.from({ length: 5 }, () => claimEpisodeRefill(campaignId)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimEpisodeRefill(campaignId)).toBe(false);
  });

  it("a NEW episode (served somebody, then dry again) gets its own attempt", async () => {
    const campaignId = randomId();
    await recordAudienceAvailability(campaignId, ORG, false);
    expect(await claimEpisodeRefill(campaignId)).toBe(true);

    await recordAudienceAvailability(campaignId, ORG, true);
    await recordAudienceAvailability(campaignId, ORG, false);
    expect(await claimEpisodeRefill(campaignId)).toBe(true);

    const periods = await db
      .select()
      .from(campaignAudienceAvailability)
      .where(eq(campaignAudienceAvailability.campaignId, campaignId));
    expect(periods.filter((p) => p.refillAttemptedAt !== null)).toHaveLength(2);
    expect(periods.find((p) => p.hasAudience)?.refillAttemptedAt).toBeNull();
  });

  it("never claims for a campaign that has people, or that nothing was recorded for", async () => {
    const campaignId = randomId();
    expect(await claimEpisodeRefill(campaignId)).toBe(false);
    await recordAudienceAvailability(campaignId, ORG, true);
    expect(await claimEpisodeRefill(campaignId)).toBe(false);
  });
});
