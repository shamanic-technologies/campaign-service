/**
 * Is `zone` an IANA timezone name (e.g. `Europe/London`, `America/New_York`, `UTC`)? Pure.
 *
 * The SAME rule lead-service applies to a stated person timezone (PUSHED-PERSON-TZ-1014): an
 * `Area/Location` name (or `UTC`) the runtime can schedule in. An offset spelling (`GMT+1`, `+01:00`)
 * is refused by name at our door, so a push is never accepted here and refused one hop down.
 */
export function isIanaTimezone(zone: string): boolean {
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(zone) && zone !== "UTC") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
