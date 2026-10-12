import { describe, it, expect } from "vitest";
import { renamedUnitName } from "../../src/lib/sales-funnel-name.js";

describe("renamedUnitName (a funnel name follows its id)", () => {
  const sfc = "e07a4362-0000-4000-8000-000000000001";
  it("swaps the funnel name in the `<name> <idTag> - ` prefix, keeps the rest", () => {
    expect(renamedUnitName("Epiphany e07a4362 - your-team-website - b - o - website_visit_to_purchase", sfc, "Epiphany", "Philanthropy"))
      .toBe("Philanthropy e07a4362 - your-team-website - b - o - website_visit_to_purchase");
  });
  it("a unit not carrying this funnel campaign's prefix is left alone", () => {
    expect(renamedUnitName("sourcing-apollo-cold-filters - b - o - start_to_lead_found", sfc, "Epiphany", "Philanthropy")).toBeNull();
    expect(renamedUnitName("pressbeat.io — Sales meeting interest", sfc, "Epiphany", "Philanthropy")).toBeNull();
    expect(renamedUnitName("Epiphany a5a5f05c - your-team-website", sfc, "Epiphany", "Philanthropy")).toBeNull();
  });
});
