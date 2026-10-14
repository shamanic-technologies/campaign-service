import { describe, expect, it } from "vitest";
import { RecordTriggerEventBody } from "../../src/schemas.js";
import { isIanaTimezone } from "../../src/lib/iana-timezone.js";
import { eventPerson, storedEventPerson } from "../../src/lib/trigger-person.js";

/** A pushed person may carry the timezone the client states for them (PUSHED-PERSON-TZ-1014). */
describe("a pushed person's stated timezone", () => {
  const base = { triggerId: "email_pushed_via_api", brandId: "4769db14-0000-4000-8000-000000000001", offerId: "4769db14-0000-4000-8000-000000000002" };

  it("accepts IANA names and refuses offsets", () => {
    for (const z of ["Europe/London", "America/New_York", "UTC", "America/Argentina/Buenos_Aires"]) expect(isIanaTimezone(z), z).toBe(true);
    for (const z of ["GMT+1", "+01:00", "Europe/Nowhere", "london", ""]) expect(isIanaTimezone(z), z).toBe(false);
  });

  it("the door refuses a non-IANA zone by name", () => {
    const r = RecordTriggerEventBody.safeParse({ ...base, person: { email: "a@x.com", timezone: "GMT+1" } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("person.timezone must be an IANA timezone");
  });

  it("the door keeps a stated zone with the person, and a push with none is unchanged", () => {
    const r = RecordTriggerEventBody.safeParse({ ...base, person: { email: "A@x.com", phone: "+44 7700 900123", timezone: "America/New_York" } });
    expect(r.success).toBe(true);
    const p = eventPerson(r.success ? r.data.person! : { email: "" });
    expect(p).toMatchObject({ email: "a@x.com", phone: "+44 7700 900123", timezone: "America/New_York" });
    expect(storedEventPerson(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect("timezone" in eventPerson({ email: "a@x.com" })).toBe(false);
    expect("timezone" in storedEventPerson({ email: "a@x.com" })!).toBe(false);
  });
});
