/**
 * Service client for cross-service calls from campaign-service
 */

const APOLLO_SERVICE_URL = process.env.APOLLO_SERVICE_URL || "http://localhost:3003";

// Service API keys for inter-service auth
const APOLLO_SERVICE_API_KEY = process.env.APOLLO_SERVICE_API_KEY;

export interface LeadData {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  title: string | null;
  organizationName: string | null;
  organizationDomain: string | null;
  organizationIndustry: string | null;
  organizationSize: string | null;
  linkedinUrl: string | null;
  enrichmentRunId: string | null;
  createdAt: string;
}

async function fetchData<T>(url: string, clerkOrgId: string, apiKey?: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Clerk-Org-Id": clerkOrgId,
    };

    if (apiKey) {
      headers["X-API-Key"] = apiKey;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      console.warn(`[Campaign Service] Data fetch failed: ${url} - ${response.status}`);
      return null;
    }

    return await response.json() as T;
  } catch (error) {
    const cause = error instanceof Error && 'cause' in error ? (error.cause as { code?: string }) : null;
    if (cause?.code === 'ECONNREFUSED') {
      console.warn(`[Campaign Service] Data fetch error: ${url} - connection refused`);
    } else {
      console.warn(`[Campaign Service] Data fetch error: ${url} - ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    return null;
  }
}

export async function getLeadsForRuns(
  runIds: string[],
  clerkOrgId: string
): Promise<LeadData[]> {
  if (runIds.length === 0) return [];

  const allLeads: LeadData[] = [];

  // Fetch leads for each run from apollo-service
  for (const runId of runIds) {
    const result = await fetchData<{ enrichments: LeadData[] }>(
      `${APOLLO_SERVICE_URL}/enrichments/${runId}`,
      clerkOrgId,
      APOLLO_SERVICE_API_KEY
    );
    if (result?.enrichments) {
      allLeads.push(...result.enrichments);
    }
  }

  return allLeads;
}

export interface CompanyData {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: string | null;
  leadsCount: number;
  enrichmentRunIds: string[];
}

export function aggregateCompaniesFromLeads(leads: LeadData[]): CompanyData[] {
  // Group leads by organization name
  const companyMap = new Map<string, {
    name: string;
    domain: string | null;
    industry: string | null;
    employeeCount: string | null;
    leadsCount: number;
    enrichmentRunIds: string[];
  }>();

  for (const lead of leads) {
    const orgName = lead.organizationName;
    if (!orgName) continue;

    const existing = companyMap.get(orgName);
    if (existing) {
      existing.leadsCount++;
      if (lead.enrichmentRunId) {
        existing.enrichmentRunIds.push(lead.enrichmentRunId);
      }
    } else {
      companyMap.set(orgName, {
        name: orgName,
        domain: lead.organizationDomain || null,
        industry: lead.organizationIndustry || null,
        employeeCount: lead.organizationSize || null,
        leadsCount: 1,
        enrichmentRunIds: lead.enrichmentRunId ? [lead.enrichmentRunId] : [],
      });
    }
  }

  // Convert to array with IDs
  return Array.from(companyMap.entries()).map(([name, data], index) => ({
    id: `company-${index}`,
    ...data,
  }));
}
