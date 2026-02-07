/**
 * Service client for cross-service calls from campaign-service
 */

const APOLLO_SERVICE_URL = process.env.APOLLO_SERVICE_URL || "http://localhost:3003";
const EMAILGENERATION_SERVICE_URL = process.env.EMAILGENERATION_SERVICE_URL || "http://localhost:3004";
const POSTMARK_SERVICE_URL = process.env.POSTMARK_SERVICE_URL || "http://localhost:3006";
const INSTANTLY_SERVICE_URL = process.env.INSTANTLY_SERVICE_URL || "http://localhost:3007";

// Service API keys for inter-service auth
const APOLLO_SERVICE_API_KEY = process.env.APOLLO_SERVICE_API_KEY;
const EMAILGENERATION_SERVICE_API_KEY = process.env.EMAILGENERATION_SERVICE_API_KEY;
const POSTMARK_SERVICE_API_KEY = process.env.POSTMARK_SERVICE_API_KEY;
const INSTANTLY_SERVICE_API_KEY = process.env.INSTANTLY_SERVICE_API_KEY;

interface ApolloStats {
  leadsFound: number;
  searchesCount: number;
  totalPeopleFromSearches: number;
}

interface EmailGenStats {
  emailsGenerated: number;
}

interface EmailSendingStats {
  emailsSent: number;
  emailsOpened: number;
  emailsClicked: number;
  emailsReplied: number;
  emailsBounced: number;
  repliesWillingToMeet: number;
  repliesInterested: number;
  repliesNotInterested: number;
  repliesOutOfOffice: number;
  repliesUnsubscribe: number;
}

export interface AggregatedStats {
  leadsFound: number;
  emailsGenerated: number;
  emailsSent: number;
  emailsOpened: number;
  emailsClicked: number;
  emailsReplied: number;
  emailsBounced: number;
  repliesWillingToMeet: number;
  repliesInterested: number;
  repliesNotInterested: number;
  repliesOutOfOffice: number;
  repliesUnsubscribe: number;
}

export interface StatsError {
  service: string;
  error: string;
}

export interface AggregatedStatsResult {
  stats: AggregatedStats;
  errors: StatsError[];
}

type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; service: string; error: string };

async function fetchStats<T>(url: string, serviceName: string, clerkOrgId: string, body: unknown, apiKey?: string): Promise<ServiceResult<T>> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Clerk-Org-Id": clerkOrgId,
    };

    if (apiKey) {
      headers["X-API-Key"] = apiKey;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const msg = `HTTP ${response.status}`;
      console.warn(`[Campaign Service] Stats fetch failed: ${url} - ${msg}`);
      return { ok: false, service: serviceName, error: msg };
    }

    const data = await response.json();
    if (data.stats == null) {
      console.warn(`[Campaign Service] Stats fetch returned no stats: ${url}`);
      return { ok: false, service: serviceName, error: "no stats in response" };
    }
    return { ok: true, data: data.stats as T };
  } catch (error) {
    const cause = error instanceof Error && 'cause' in error ? (error.cause as { code?: string }) : null;
    const msg = cause?.code === 'ECONNREFUSED'
      ? 'connection refused'
      : (error instanceof Error ? error.message : 'unknown error');
    console.warn(`[Campaign Service] Stats fetch error: ${url} - ${msg}`);
    return { ok: false, service: serviceName, error: msg };
  }
}

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

export interface ModelStats {
  model: string;
  count: number;
  runIds: string[];
}

export interface ModelStatsResult {
  stats: ModelStats[];
  errors: StatsError[];
}

/**
 * Get email generation stats grouped by model
 */
export async function getStatsByModel(runIds: string[]): Promise<ModelStatsResult> {
  if (runIds.length === 0) return { stats: [], errors: [] };

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (EMAILGENERATION_SERVICE_API_KEY) {
      headers["X-API-Key"] = EMAILGENERATION_SERVICE_API_KEY;
    }

    const response = await fetch(`${EMAILGENERATION_SERVICE_URL}/stats/by-model`, {
      method: "POST",
      headers,
      body: JSON.stringify({ runIds }),
    });

    if (!response.ok) {
      const msg = `HTTP ${response.status}`;
      console.warn(`[Campaign Service] Stats by model fetch failed: ${msg}`);
      return { stats: [], errors: [{ service: "emailgen", error: msg }] };
    }

    const data = await response.json();
    return { stats: data.stats || [], errors: [] };
  } catch (error) {
    const cause = error instanceof Error && 'cause' in error ? (error.cause as { code?: string }) : null;
    const msg = cause?.code === 'ECONNREFUSED'
      ? 'connection refused'
      : (error instanceof Error ? error.message : 'unknown error');
    console.warn(`[Campaign Service] Stats by model fetch error: ${msg}`);
    return { stats: [], errors: [{ service: "emailgen", error: msg }] };
  }
}

const EMPTY_SENDING_STATS: EmailSendingStats = {
  emailsSent: 0, emailsOpened: 0, emailsClicked: 0, emailsReplied: 0, emailsBounced: 0,
  repliesWillingToMeet: 0, repliesInterested: 0, repliesNotInterested: 0,
  repliesOutOfOffice: 0, repliesUnsubscribe: 0,
};

function addSendingStats(a: EmailSendingStats, b: EmailSendingStats): EmailSendingStats {
  return {
    emailsSent: a.emailsSent + b.emailsSent,
    emailsOpened: a.emailsOpened + b.emailsOpened,
    emailsClicked: a.emailsClicked + b.emailsClicked,
    emailsReplied: a.emailsReplied + b.emailsReplied,
    emailsBounced: a.emailsBounced + b.emailsBounced,
    repliesWillingToMeet: a.repliesWillingToMeet + b.repliesWillingToMeet,
    repliesInterested: a.repliesInterested + b.repliesInterested,
    repliesNotInterested: a.repliesNotInterested + b.repliesNotInterested,
    repliesOutOfOffice: a.repliesOutOfOffice + b.repliesOutOfOffice,
    repliesUnsubscribe: a.repliesUnsubscribe + b.repliesUnsubscribe,
  };
}

export async function getAggregatedStats(
  runIds: string[],
  clerkOrgId: string
): Promise<AggregatedStatsResult> {
  const emptyStats: AggregatedStats = {
    leadsFound: 0, emailsGenerated: 0,
    emailsSent: 0, emailsOpened: 0, emailsClicked: 0, emailsReplied: 0, emailsBounced: 0,
    repliesWillingToMeet: 0, repliesInterested: 0, repliesNotInterested: 0,
    repliesOutOfOffice: 0, repliesUnsubscribe: 0,
  };

  if (runIds.length === 0) {
    return { stats: emptyStats, errors: [] };
  }

  const body = { runIds };
  const errors: StatsError[] = [];

  // Fetch stats from all 4 services in parallel
  const [apolloResult, emailGenResult, postmarkResult, instantlyResult] = await Promise.all([
    fetchStats<ApolloStats>(`${APOLLO_SERVICE_URL}/stats`, "apollo", clerkOrgId, body, APOLLO_SERVICE_API_KEY),
    fetchStats<EmailGenStats>(`${EMAILGENERATION_SERVICE_URL}/stats`, "emailgen", clerkOrgId, body, EMAILGENERATION_SERVICE_API_KEY),
    fetchStats<EmailSendingStats>(`${POSTMARK_SERVICE_URL}/stats`, "postmark", clerkOrgId, body, POSTMARK_SERVICE_API_KEY),
    fetchStats<EmailSendingStats>(`${INSTANTLY_SERVICE_URL}/stats`, "instantly", clerkOrgId, body, INSTANTLY_SERVICE_API_KEY),
  ]);

  // Collect errors
  if (!apolloResult.ok) errors.push({ service: apolloResult.service, error: apolloResult.error });
  if (!emailGenResult.ok) errors.push({ service: emailGenResult.service, error: emailGenResult.error });
  if (!postmarkResult.ok) errors.push({ service: postmarkResult.service, error: postmarkResult.error });
  if (!instantlyResult.ok) errors.push({ service: instantlyResult.service, error: instantlyResult.error });

  // Sum Postmark + Instantly email metrics (a campaign uses one or the other)
  const postmarkData = postmarkResult.ok ? postmarkResult.data : EMPTY_SENDING_STATS;
  const instantlyData = instantlyResult.ok ? instantlyResult.data : EMPTY_SENDING_STATS;
  const emailStats = addSendingStats(postmarkData, instantlyData);

  return {
    stats: {
      leadsFound: apolloResult.ok ? (apolloResult.data.leadsFound ?? 0) : 0,
      emailsGenerated: emailGenResult.ok ? (emailGenResult.data.emailsGenerated ?? 0) : 0,
      emailsSent: emailStats.emailsSent,
      emailsOpened: emailStats.emailsOpened,
      emailsClicked: emailStats.emailsClicked,
      emailsReplied: emailStats.emailsReplied,
      emailsBounced: emailStats.emailsBounced,
      repliesWillingToMeet: emailStats.repliesWillingToMeet,
      repliesInterested: emailStats.repliesInterested,
      repliesNotInterested: emailStats.repliesNotInterested,
      repliesOutOfOffice: emailStats.repliesOutOfOffice,
      repliesUnsubscribe: emailStats.repliesUnsubscribe,
    },
    errors,
  };
}
