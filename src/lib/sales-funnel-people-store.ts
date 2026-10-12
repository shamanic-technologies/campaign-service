import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { salesFunnelCampaigns } from "../db/schema.js";
import {
  fileNamedPerson,
  storedPeople,
  withFiledLeadIds,
  type NamedPerson,
  type SalesFunnelCampaignTargeting,
} from "./sales-funnel-people.js";

/** The reads of lib/sales-funnel-people.ts (kept apart so the rules stay importable without a database). */

/** For each funnel campaign id, what it names (people, instruction). One query. */
export async function targetingOfSalesFunnelCampaigns(
  salesFunnelCampaignIds: readonly string[],
): Promise<Map<string, SalesFunnelCampaignTargeting>> {
  const ids = [...new Set(salesFunnelCampaignIds)];
  const out = new Map<string, SalesFunnelCampaignTargeting>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: salesFunnelCampaigns.id,
      people: salesFunnelCampaigns.people,
      instruction: salesFunnelCampaigns.instruction,
      githubIssue: salesFunnelCampaigns.githubIssue,
    })
    .from(salesFunnelCampaigns)
    .where(inArray(salesFunnelCampaigns.id, ids));
  for (const r of rows) {
    out.set(r.id, { people: storedPeople(r.people), instruction: r.instruction ?? null, githubIssue: r.githubIssue ?? null });
  }
  return out;
}


/**
 * File every named person of a funnel campaign under each of its units with a workflow (lead-service),
 * and keep the lead ids lead-service answered on the funnel campaign's `people`. Never throws: every
 * outcome is returned (and a failure logged), a person not filed now is filed again when an event
 * needs them (lib/step-trigger.ts).
 */
export async function fileSalesFunnelCampaignPeople(input: {
  salesFunnelCampaignId: string;
  orgId: string;
  people: readonly NamedPerson[];
  units: ReadonlyArray<{ id: string; workflowSlug: string | null }>;
  userId?: string | null;
  runId?: string | null;
}): Promise<{ people: NamedPerson[]; filing: FilingReport[] }> {
  const filed = new Map<string, string>();
  const filing: FilingReport[] = [];
  for (const unit of input.units.filter((u) => u.workflowSlug)) {
    for (const person of input.people) {
      const outcome = await fileNamedPerson({
        orgId: input.orgId,
        campaignId: unit.id,
        email: person.email,
        userId: input.userId,
        runId: input.runId,
      });
      if (outcome.ok) {
        filed.set(person.email, outcome.leadId);
        filing.push({ email: person.email, campaignId: unit.id, outcome: outcome.filed ? "filed" : "already_filed", leadId: outcome.leadId });
      } else {
        console.error(
          `[campaign-service] sales funnel campaign ${input.salesFunnelCampaignId}: ${person.email} not filed on unit ${unit.id} (${outcome.code}): ${outcome.detail}`,
        );
        filing.push({ email: person.email, campaignId: unit.id, outcome: outcome.code, leadId: null });
      }
    }
  }
  const people = withFiledLeadIds(input.people, filed);
  if (filed.size > 0) {
    await db
      .update(salesFunnelCampaigns)
      .set({ people })
      .where(eq(salesFunnelCampaigns.id, input.salesFunnelCampaignId));
  }
  return { people, filing };
}

export interface FilingReport {
  email: string;
  campaignId: string;
  /** `filed` | `already_filed`, or the refusal: `person_not_known` | `ambiguous_person` | `campaign_has_no_brand` | `filing_unavailable`. */
  outcome: string;
  leadId: string | null;
}
