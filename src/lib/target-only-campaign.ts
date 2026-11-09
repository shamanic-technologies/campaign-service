/**
 * MIGRATE-1105 S8 (BACKLINK-ENGINE-1109): a campaign is Target + start + budget + brief. A campaign launched with a
 * TARGET and no sales funnel (an outcome only its Engine makes, e.g. `backlink_earned`, `industry_news_found`) owns ONE
 * unit, born on its Engine (`engine:<target>`), with no channel and no leg: the Engine's Rating picks the script.
 *
 * Such a campaign stores its target as its funnel id (the column is NOT NULL and billing's caps are keyed on it), so
 * it is recognised by `salesFunnelId === target`: a real funnel id is a chain of legs (`a_to_b@channel+…`), never a
 * bare step key. Its target therefore never moves (the unit's Engine is named after it).
 */
import { engineOutcomeOfSlug, engineUnitWorkflowSlug } from "./engine-dispatch.js";

/** A funnel campaign launched on its target alone (no sales funnel). Pure. */
export function isTargetOnlyCampaign(row: { salesFunnelId: string; target: string | null }): boolean {
  return row.target !== null && row.salesFunnelId === row.target;
}

/** A unit of a target-only campaign: no channel, no leg, born on its Engine. Pure. */
export function isEngineOnlyUnit(unit: { featureSlug?: string | null; legKey?: string | null; workflowSlug?: string | null }): boolean {
  return !unit.featureSlug && !unit.legKey && engineOutcomeOfSlug(unit.workflowSlug) !== null;
}

/** The one unit a target-only campaign is born with. Pure. */
export function targetOnlyUnitBirth(target: string, name: string) {
  return {
    featureSlug: null,
    legKey: null,
    workflowSlug: engineUnitWorkflowSlug(target),
    acquisitionChannel: null,
    runsOnTriggerId: null,
    name,
  };
}
