/**
 * E.164: `+`, a country code that never starts with 0, at most 15 digits in all. The identity a person
 * known only by phone is filed on (REPLY-PHONE-ONLY-1015). Spaces, dashes, dots and parentheses a caller
 * types are not part of the number: `canonicalPhone` drops them before the check. Pure.
 */
const E164 = /^\+[1-9]\d{6,14}$/;

export function canonicalPhone(phone: string): string {
  return phone.trim().replace(/[\s\-().]/g, "");
}

export function isE164Phone(phone: string): boolean {
  return E164.test(canonicalPhone(phone));
}
