/**
 * A TRIGGER AT THE HEAD OF A SALES FUNNEL (owner 2026-10-15, FUNNEL-HEAD-TRIGGER-1015; standard vocabulary MUST-HAVE 3
 * and 4).
 *
 * Job: "When this fact happens for this person, run every live campaign that starts on it, whatever pipes its funnel
 * reuses." features-service may now head a funnel with a trigger (`trigger:<triggerId>+<legs>`, read through its
 * sales-funnel detail `trigger {slug, name}`, never split): "⚡ Lead -> [Sales Cold Email Outreach] -> Positive reply
 * -> [Your team] -> Paid client" reuses the PROACTIVE cold email pipe and its best-ROI workflows (a reactive twin of
 * every pipe was rejected: it has no workflow of its own).
 *
 * ONE rule for every funnel, decided at the unit's BIRTH from the funnel read (`unitRunsOnTrigger`) and kept on the
 * unit (`campaigns.runs_on_trigger_id`):
 *  - the funnel serves a trigger T, and
 *  - the unit is on the funnel's HEAD leg or its pipe is PROACTIVE, and
 *  - its own pipe does not already answer T (a legacy reactive funnel's head pipe does: it keeps firing exactly as
 *    today, through its pipe's transition, and keeps its cadence),
 * then the unit runs on T and ONLY on T:
 *  - fired by every event of T on its (org, brand, offer) (lib/trigger-events.ts `fireTrigger`, and the step route
 *    for the step T leaves from), with the event's person and item, through the same guards and money checks;
 *  - never dispatched by the scheduler nor a person's start (lib/on-demand-mode.ts `answersOnDemand`: parked like
 *    a unit answering on demand), so its proactive pipe never spends on its own every-tick budget.
 * A later REACTIVE pipe of the funnel keeps its own trigger (a positive reply runs AI Meeting Booking, never ⚡ Lead).
 *
 * Every unit born before this, and every funnel features-service serves with no trigger, has NULL: unchanged.
 */
import type { CatalogueTriggerTransition, ChannelCatalogueRead, CatalogueTriggerType } from "./channel-operator-client.js";
import { sameLeg } from "./leg-identity.js";

export interface HeadTriggerUnit {
  pipeId: string;
  featureSlug: string;
  legKey: string;
  mode: "proactive" | "reactive";
}

/** The trigger a unit of this funnel runs on, or null (it runs as every unit always has). Pure. */
export function unitRunsOnTrigger(
  salesFunnel: { triggerId: string | null; headPipeId: string | null },
  unit: HeadTriggerUnit,
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
): string | null {
  const triggerId = salesFunnel.triggerId;
  if (!triggerId) return null;
  const head = salesFunnel.headPipeId !== null && unit.pipeId === salesFunnel.headPipeId;
  if (!head && unit.mode !== "proactive") return null;
  const pipeAnswers = (catalogue.triggerTransitions ?? []).some(
    (t) => t.triggerId === triggerId && t.featureSlug === unit.featureSlug && sameLeg(unit.featureSlug, t.legKey, unit.legKey),
  );
  return pipeAnswers ? null : triggerId;
}

/**
 * WHO ANSWERS TRIGGER T, the ONE rule every reader shares (the event dispatch, the delay / poll / GitHub detectors'
 * scopes and payers): a campaign on a (channel, leg) whose reactive transition names T, or a unit of a funnel headed
 * by T (`runsOnTriggerId`). Pure.
 */
export function answersTrigger(
  c: { featureSlug: string | null; legKey: string | null; runsOnTriggerId?: string | null },
  triggerId: string,
  transitions: ReadonlyArray<CatalogueTriggerTransition>,
): boolean {
  if (runsOnTrigger(c, triggerId)) return true;
  const slug = c.featureSlug;
  if (!slug || !c.legKey) return false;
  return transitions.some((t) => t.triggerId === triggerId && t.featureSlug === slug && sameLeg(slug, t.legKey, c.legKey));
}

/** True when an event of `triggerId` fires this campaign as a unit of a funnel headed by it. Pure. */
export function runsOnTrigger(c: { runsOnTriggerId?: string | null }, triggerId: string | null | undefined): boolean {
  return !!triggerId && c.runsOnTriggerId === triggerId;
}

/** The public door's refusal reason for a trigger no outside caller may fire. */
export const TRIGGER_NOT_CALLABLE = "trigger_not_callable";

/**
 * Why the PUBLIC door (an outside caller, api-service `POST /v1/trigger-events`) refuses this trigger, or null when it
 * accepts it. features-service states `callable` (false on a condition we compute: delay, poll, GitHub issue in prod;
 * and on a request between our services: `on_demand`, `lead_requested`); a trigger with no `callable` served yet is
 * accepted (nothing changes until it is served). The internal door never asks (our services fire every declared
 * trigger); our detectors write their own rows. Pure.
 */
export function doorRefusal(type: Pick<CatalogueTriggerType, "id" | "label" | "callable">): string | null {
  if (type.callable !== false) return null;
  return `trigger ${JSON.stringify(type.id)} ("${type.label}") is fired by distribute itself; it cannot be reported through the API`;
}
