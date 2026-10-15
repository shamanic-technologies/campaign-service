import { describe, expect, it } from "vitest";
import { eventPerson, personLabel, storedEventPerson } from "../../src/lib/trigger-person.js";
import { canonicalPhone, isE164Phone } from "../../src/lib/e164-phone.js";
import { RecordTriggerEventBody } from "../../src/schemas.js";

/** REPLY-PHONE-ONLY-1015: a person who writes on WhatsApp is often known only by phone + name. */
describe("a person known only by phone", () => {
  it("E.164: separators dropped, country code required", () => {
    expect(canonicalPhone(" +44 (0)7700-900.123 ")).toBe("+4407700900123");
    expect(isE164Phone("+44 7700 900123")).toBe(true);
    expect(isE164Phone("07700 900123")).toBe(false);
    expect(isE164Phone("+0123456789")).toBe(false);
    expect(isE164Phone("+12")).toBe(false);
  });

  it("the door accepts phone + name with no email, refuses neither / a local number", () => {
    const base = { triggerId: "positive_reply_received", brandId: "75d7e3e8-0000-4000-8000-000000000022", offerId: "231bb036-0000-4000-8000-000000000023" };
    expect(RecordTriggerEventBody.safeParse({ ...base, person: { phone: "+447700900123", name: "Velveteen (WA)" } }).success).toBe(true);
    expect(RecordTriggerEventBody.safeParse({ ...base, person: { name: "Nobody" } }).success).toBe(false);
    expect(RecordTriggerEventBody.safeParse({ ...base, person: { phone: "07700 900123" } }).success).toBe(false);
    // An email with a phone in any spelling: as before.
    expect(RecordTriggerEventBody.safeParse({ ...base, person: { email: "a@x.com", phone: "07700 900123" } }).success).toBe(true);
  });

  it("canonical: the phone IS the identity (E.164) when there is no email; beside an email it stays as stated", () => {
    expect(eventPerson({ phone: " +44 7700 900123 ", name: " Velveteen (WA) " })).toEqual({
      email: null, name: "Velveteen (WA)", phone: "+447700900123", crmContact: null,
    });
    expect(eventPerson({ email: " A@X.com ", phone: "+44 7700 900123" })).toMatchObject({ email: "a@x.com", phone: "+44 7700 900123" });
  });

  it("read back from the row: a phone-only person survives a retry; nothing identifying = no person", () => {
    expect(storedEventPerson({ email: null, phone: "+447700900123", name: "V" })).toEqual({
      email: null, name: "V", phone: "+447700900123", crmContact: null,
    });
    expect(storedEventPerson({ name: "V" })).toBeNull();
    expect(personLabel({ email: null, phone: "+447700900123" })).toBe("+447700900123");
    expect(personLabel({ email: "a@x.com", phone: "+447700900123" })).toBe("a@x.com");
  });
});
