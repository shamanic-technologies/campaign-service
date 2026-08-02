import { describe, it, expect } from "vitest";
import {
  acquisitionChannelForFeature,
  campaignIdentityColumns,
} from "../../src/lib/campaign-identity.js";

describe("acquisitionChannelForFeature", () => {
  it("names the medium for the features that state a sales funnel", () => {
    expect(acquisitionChannelForFeature("sales-cold-email-outreach")).toBe("cold_email");
    expect(acquisitionChannelForFeature("sales-crm-email-outreach")).toBe("crm_email");
  });

  it("never folds two different products onto one channel", () => {
    // A brand can legitimately run PR outreach and sales outreach at once, both by cold email, and
    // both stating no funnel. Naming them both `cold_email` would make them ONE identity, so the
    // second would collide with the first and could never exist.
    const channels = [
      "sales-cold-email-outreach",
      "pr-cold-email-outreach",
      "hiring-cold-email-outreach",
      "vc-cold-email-outreach",
      "sales-crm-email-outreach",
      "pr-expert-quote-outreach",
      "pr-expert-quote-opportunities",
      "ai-visibility-scoring",
      "press-kit-page-generation",
      "outlet-database-discovery",
    ].map(acquisitionChannelForFeature);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("gives a feature it has never heard of its own channel rather than someone else's", () => {
    expect(acquisitionChannelForFeature("some-future-feature")).toBe("some_future_feature");
  });

  it("states no channel for a campaign that states no feature", () => {
    expect(acquisitionChannelForFeature(null)).toBeNull();
    expect(acquisitionChannelForFeature(undefined)).toBeNull();
    expect(acquisitionChannelForFeature("")).toBeNull();
  });
});

describe("campaignIdentityColumns", () => {
  it("states the brand as a scalar — no unique index can span the array", () => {
    expect(campaignIdentityColumns({ brandIds: ["brand-1"], featureSlug: "sales-cold-email-outreach" }))
      .toEqual({ brandId: "brand-1", acquisitionChannel: "cold_email" });
  });

  it("takes the first brand of a historical multi-brand row", () => {
    expect(campaignIdentityColumns({ brandIds: ["a", "b"], featureSlug: null }).brandId).toBe("a");
  });

  it("leaves both null when the campaign states neither", () => {
    expect(campaignIdentityColumns({})).toEqual({ brandId: null, acquisitionChannel: null });
    expect(campaignIdentityColumns({ brandIds: [] }).brandId).toBeNull();
  });
});
