import { describe, it, expect } from "vitest";
import { eventConcernsPeople, namedPeople, peopleKeyOf, storedPeople, unitPeople } from "../../src/lib/sales-funnel-people.js";

describe("sales funnel people (pure rules)", () => {
  it("names people canonically: trimmed, lowercased, deduplicated, sorted", () => {
    expect(namedPeople([{ email: " B@x.com" }, { email: "a@x.com" }, { email: "b@X.com " }])).toEqual([
      { email: "a@x.com", leadId: null },
      { email: "b@x.com", leadId: null },
    ]);
  });

  it("their identity does not depend on order or case; nobody is ''", () => {
    expect(peopleKeyOf([{ email: "B@x.com" }, { email: "a@x.com" }])).toBe("a@x.com,b@x.com");
    expect(peopleKeyOf([{ email: "a@x.com" }, { email: "b@x.com" }])).toBe("a@x.com,b@x.com");
    expect(peopleKeyOf(null)).toBe("");
    expect(peopleKeyOf([])).toBe("");
  });

  it("reads the stored column defensively", () => {
    expect(storedPeople(null)).toBeNull();
    expect(storedPeople([])).toBeNull();
    expect(storedPeople([{ email: "a@x.com", leadId: "L1" }, { nope: 1 }])).toEqual([{ email: "a@x.com", leadId: "L1" }]);
  });

  it("an event naming nobody concerns every campaign; one naming a lead concerns only who names it", () => {
    const people = [{ email: "a@x.com", leadId: "L1" }];
    expect(eventConcernsPeople(people, null)).toBe(true);
    expect(eventConcernsPeople(people, "L1")).toBe(true);
    expect(eventConcernsPeople(people, "L2")).toBe(false);
    expect(eventConcernsPeople([{ email: "a@x.com", leadId: null }], "L1")).toBe(false);
  });

  it("a pre-funnel campaign names nobody", () => {
    expect(unitPeople({ salesFunnelCampaignId: null }, new Map())).toBeNull();
    const t = new Map([["F", { people: [{ email: "a@x.com", leadId: null }], instruction: null }]]);
    expect(unitPeople({ salesFunnelCampaignId: "F" }, t)).toEqual([{ email: "a@x.com", leadId: null }]);
  });
});
