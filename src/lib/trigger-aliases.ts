import type { CatalogueTriggerType } from "./channel-operator-client.js";

/**
 * ONE TRIGGER PER FACT (owner 2026-10-16, STD-VOCAB-CONDITION-1016). features-service merges a trigger id into another
 * when both say the same fact (`follow_up_date_reached` -> `follow_up_due`) and serves the table on `/public/channels`
 * `triggerAliases[]` (read by lib/channel-operator-client.ts). Keys are frozen: the old id keeps RESOLVING, so a caller
 * still reporting it (workflow-service's prospect follow-up) is recorded as the target, and an occurrence recorded under
 * it before the merge (pending, future-dated) fires as the target. Pure; its own module because tests replace
 * channel-operator-client.js wholesale.
 *
 * The trigger type an id names: itself, or the one it was MERGED into (`triggerAliases`). Null = not declared.
 * Every reader turning a CALLER's or a STORED trigger id into a type goes through here (record route, due-event fire).
 */
export function resolveTriggerType(
  catalogue: { triggers?: ReadonlyMap<string, CatalogueTriggerType>; triggerAliases?: ReadonlyMap<string, string> },
  id: string,
): CatalogueTriggerType | null {
  const own = catalogue.triggers?.get(id);
  if (own) return own;
  const target = catalogue.triggerAliases?.get(id);
  return target ? (catalogue.triggers?.get(target) ?? null) : null;
}

