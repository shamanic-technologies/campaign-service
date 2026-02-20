export const COLD_EMAIL_PROMPT = `You are an expert sales copywriter. Write a personalized cold email for a potential client.

## Recipient Information
- Name: {{leadFirstName}} {{leadLastName}}
- Title: {{leadTitle}}
- Email: {{leadEmail}}
- LinkedIn: {{leadLinkedinUrl}}
- Company: {{leadCompanyName}}
- Domain: {{leadCompanyDomain}}
- Industry: {{leadCompanyIndustry}}
- Company Size: {{leadCompanySize}}
- Revenue: {{leadCompanyRevenueUsd}}

## Sender / Our Company
- Company: {{clientCompanyName}}
- Website: {{clientBrandUrl}}
- Overview: {{clientCompanyOverview}}
- Value Proposition: {{clientValueProposition}}
- Target Audience: {{clientTargetAudience}}
- Pain Points We Solve: {{clientCustomerPainPoints}}
- Key Features: {{clientKeyFeatures}}
- Differentiators: {{clientProductDifferentiators}}
- Competitors: {{clientCompetitors}}
- Social Proof (scraped): {{clientSocialProof}}
- CTA: {{clientCallToAction}}
- Additional Context: {{clientAdditionalContext}}

## Company Credibility (scraped from brand website)
- Leadership Team: {{clientLeadership}}
- Funding: {{clientFunding}}
- Awards & Recognition: {{clientAwardsAndRecognition}}
- Revenue Milestones: {{clientRevenueMilestones}}

## Sales Persuasion Intelligence (scraped from brand website)
- Urgency Signals: {{clientUrgency}}
- Scarcity Signals: {{clientScarcity}}
- Risk Reversal (guarantees, trials, refund policy): {{clientRiskReversal}}
- Price Anchoring: {{clientPriceAnchoring}}
- Value Stacking: {{clientValueStacking}}

## Campaign Goals
- Target Outcome: {{targetOutcome}}
- Value for Target: {{valueForTarget}}

## Sales Persuasion Levers (user-provided, override scraped if present)
- Urgency: {{urgency}}
- Scarcity: {{scarcity}}
- Risk Reversal: {{riskReversal}}
- Social Proof (user-provided): {{socialProof}}

## Reference: Cold Email Frameworks
Use your expertise to craft the email. Here are proven frameworks for reference:

**PAS (Problem-Agitate-Solution)**
Identify a problem, amplify its consequences, present solution.

**BAB (Before-After-Bridge)**
Describe current pain (Before), paint ideal future (After), position solution as the bridge.

**AIDA (Attention-Interest-Desire-Action)**
Hook attention, build interest with value, create desire, end with CTA.

## Reference: Industry Best Practices (Gong Research, 28M+ emails analyzed)
- Avoid product pitches in cold emails (reduces replies by 57%)
- Use interest CTAs ("thoughts?" not "15 min call?") - 2x more effective
- Avoid buzzwords in subject lines (reduces open rates by 17.9%)
- No ROI claims, no "AI", no jargon in first touch
- Focus on problems you solve, not features you have

## Task
Write a compelling cold email using your judgment. Apply or combine frameworks as you see fit based on the data provided.

Keep it short (3-4 sentences max). Be genuine, not salesy. End with a low-friction CTA.
Do NOT use placeholder text like [Your Name]. Do NOT add any signature block — it will be appended automatically.

## Output Format
SUBJECT: [subject line]
---
[email body in plain text]`;

export const COLD_EMAIL_VARIABLES = [
  // Lead fields from fetch-lead
  "leadFirstName", "leadLastName", "leadTitle", "leadEmail",
  "leadLinkedinUrl", "leadCompanyName", "leadCompanyDomain",
  "leadCompanyIndustry", "leadCompanySize", "leadCompanyRevenueUsd",
  // Brand fields from brand-profile (core)
  "clientCompanyName", "clientBrandUrl", "clientCompanyOverview",
  "clientValueProposition", "clientTargetAudience", "clientCustomerPainPoints",
  "clientKeyFeatures", "clientProductDifferentiators", "clientCompetitors",
  "clientSocialProof", "clientCallToAction", "clientAdditionalContext",
  // Brand fields from brand-profile (credibility)
  "clientLeadership", "clientFunding", "clientAwardsAndRecognition",
  "clientRevenueMilestones",
  // Brand fields from brand-profile (sales persuasion intelligence)
  "clientUrgency", "clientScarcity", "clientRiskReversal",
  "clientPriceAnchoring", "clientValueStacking",
  // Campaign fields from start-run
  "targetOutcome", "valueForTarget",
  // User-provided sales persuasion
  "urgency", "scarcity", "riskReversal", "socialProof",
];

const DEFAULT_APP_ID = process.env.APP_ID || "mcpfactory";

// Confirmed workflow names from workflow-service deploy response.
// Workflow-service is the authority on names — we use its confirmed name
// rather than assuming campaign.type = workflow name.
const deployedWorkflowNames = new Map<string, string>();

/**
 * Get the confirmed workflow name for a campaign type.
 * Throws if workflow-service hasn't confirmed this name yet (fail-fast).
 */
export function getConfirmedWorkflowName(campaignType: string): string {
  const confirmed = deployedWorkflowNames.get(campaignType);
  if (!confirmed) {
    throw new Error(`Workflow name "${campaignType}" not confirmed by workflow-service. Was deployWorkflows() called?`);
  }
  return confirmed;
}

/**
 * Build the cold-email-outreach DAG.
 *
 * Pipeline:
 *   gate-check → start-run → fetch-lead → check-lead ──────────┐
 *                                           │ (found=true)      │ (found=false)
 *                                           ↓                   │
 *                                     brand-profile             │
 *                                           ↓                   │
 *                                     email-generate            │
 *                                           ↓                   │
 *                                     email-send                │
 *                                           ↓                   ↓
 *                                           end-run (always)
 *
 * - gate-check:     validate budget/volume/status limits (campaign-service)
 * - start-run:      create run + return campaign data (campaign-service)
 * - fetch-lead:     pull next lead from buffer (lead-service, NO RETRY)
 * - check-lead:     condition node — branches on found=true/false
 * - brand-profile:  fetch brand sales profile (brand-service, only when lead found)
 * - email-generate: generate email via AI (emailgeneration-service, NO RETRY)
 * - email-send:     send email (email-gateway-service, NO RETRY, validate success)
 * - end-run:        finalize run (always called, receives leadFound flag)
 * - end-run-error:  finalize run as failed (onError handler for real errors)
 *
 * end-run always executes: when leadFound=true it re-triggers, when leadFound=false
 * it auto-stops the campaign (no leads = no point retrying).
 * On real DAG error: end-run-error is called with success=false via onError handler.
 */
function buildColdEmailDag() {
  return {
    nodes: [
      // Step 0: Validate budget, volume, status limits
      {
        id: "gate-check",
        type: "http.call",
        retries: 0, // Don't retry budget/volume checks (wasteful, next loop will retry)
        config: {
          service: "campaign",
          method: "POST",
          path: "/gate-check",
          validateResponse: { field: "allowed", equals: true },
        },
        inputMapping: {
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
        },
      },
      // Step 1: Create run + return campaign data
      {
        id: "start-run",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/start-run",
        },
        inputMapping: {
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
        },
      },
      // Step 2: Pull next lead from buffer
      {
        id: "fetch-lead",
        type: "http.call",
        retries: 0, // Non-idempotent: consumes from buffer
        config: {
          service: "lead",
          method: "POST",
          path: "/buffer/next",
        },
        inputMapping: {
          "headers.x-app-id": "$ref:start-run.output.appId",
          "headers.x-org-id": "$ref:start-run.output.clerkOrgId",
          "body.campaignId": "$ref:start-run.output.campaignId",
          "body.brandId": "$ref:start-run.output.brandId",
          "body.parentRunId": "$ref:start-run.output.runId",
          "body.searchParams": "$ref:start-run.output.searchParams",
          "body.keySource": "$ref:start-run.output.keySource",
          "body.workflowName": "$ref:start-run.output.workflowName",
        },
      },
      // Step 3: Condition — branch on found=true/false
      {
        id: "check-lead",
        type: "condition",
      },
      // Step 4a: Fetch brand sales profile (only when lead found)
      {
        id: "brand-profile",
        type: "http.call",
        config: {
          service: "brand",
          method: "POST",
          path: "/sales-profile",
        },
        inputMapping: {
          "body.appId": "$ref:start-run.output.appId",
          "body.clerkOrgId": "$ref:start-run.output.clerkOrgId",
          "body.url": "$ref:start-run.output.brandUrl",
          "body.clerkUserId": "$ref:start-run.output.clerkUserId",
          "body.parentRunId": "$ref:start-run.output.runId",
          "body.keyType": "$ref:start-run.output.keySource",
          "body.workflowName": "$ref:start-run.output.workflowName",
          // User-provided sales context (may complement or override scraped data)
          "body.urgency": "$ref:start-run.output.urgency",
          "body.scarcity": "$ref:start-run.output.scarcity",
          "body.riskReversal": "$ref:start-run.output.riskReversal",
          "body.socialProof": "$ref:start-run.output.socialProof",
        },
      },
      // Step 4b: Generate email (non-idempotent, NO RETRY)
      {
        id: "email-generate",
        type: "http.call",
        retries: 0, // Non-idempotent generation
        config: {
          service: "emailgeneration",
          method: "POST",
          path: "/generate",
          body: {
            type: "cold-email",
          },
        },
        inputMapping: {
          "headers.x-clerk-org-id": "$ref:start-run.output.clerkOrgId",
          "body.appId": "$ref:start-run.output.appId",
          "body.brandId": "$ref:start-run.output.brandId",
          "body.campaignId": "$ref:start-run.output.campaignId",
          "body.runId": "$ref:start-run.output.runId",
          "body.keyMode": "$ref:start-run.output.keySource",
          "body.workflowName": "$ref:start-run.output.workflowName",
          "body.apolloEnrichmentId": "$ref:fetch-lead.output.lead.externalId",
          // Template variables — must be nested under body.variables (emailgeneration expects z.record)
          // Lead fields from fetch-lead (flat camelCase per Apollo spec)
          "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
          "body.variables.leadLastName": "$ref:fetch-lead.output.lead.data.lastName",
          "body.variables.leadTitle": "$ref:fetch-lead.output.lead.data.title",
          "body.variables.leadEmail": "$ref:fetch-lead.output.lead.data.email",
          "body.variables.leadLinkedinUrl": "$ref:fetch-lead.output.lead.data.linkedinUrl",
          "body.variables.leadCompanyName": "$ref:fetch-lead.output.lead.data.organizationName",
          "body.variables.leadCompanyDomain": "$ref:fetch-lead.output.lead.data.organizationDomain",
          "body.variables.leadCompanyIndustry": "$ref:fetch-lead.output.lead.data.organizationIndustry",
          "body.variables.leadCompanySize": "$ref:fetch-lead.output.lead.data.organizationSize",
          "body.variables.leadCompanyRevenueUsd": "$ref:fetch-lead.output.lead.data.organizationRevenueUsd",
          // Client/brand fields from brand-profile (core)
          "body.variables.clientCompanyName": "$ref:start-run.output.brandDomain",
          "body.variables.clientBrandUrl": "$ref:start-run.output.brandUrl",
          "body.variables.clientCompanyOverview": "$ref:brand-profile.output.profile.companyOverview",
          "body.variables.clientValueProposition": "$ref:brand-profile.output.profile.valueProposition",
          "body.variables.clientTargetAudience": "$ref:brand-profile.output.profile.targetAudience",
          "body.variables.clientCustomerPainPoints": "$ref:brand-profile.output.profile.customerPainPoints",
          "body.variables.clientKeyFeatures": "$ref:brand-profile.output.profile.keyFeatures",
          "body.variables.clientProductDifferentiators": "$ref:brand-profile.output.profile.productDifferentiators",
          "body.variables.clientCompetitors": "$ref:brand-profile.output.profile.competitors",
          "body.variables.clientSocialProof": "$ref:brand-profile.output.profile.socialProof",
          "body.variables.clientCallToAction": "$ref:brand-profile.output.profile.callToAction",
          "body.variables.clientAdditionalContext": "$ref:brand-profile.output.profile.additionalContext",
          // Client/brand fields from brand-profile (credibility)
          "body.variables.clientLeadership": "$ref:brand-profile.output.profile.leadership",
          "body.variables.clientFunding": "$ref:brand-profile.output.profile.funding",
          "body.variables.clientAwardsAndRecognition": "$ref:brand-profile.output.profile.awardsAndRecognition",
          "body.variables.clientRevenueMilestones": "$ref:brand-profile.output.profile.revenueMilestones",
          // Client/brand fields from brand-profile (sales persuasion intelligence)
          "body.variables.clientUrgency": "$ref:brand-profile.output.profile.urgency",
          "body.variables.clientScarcity": "$ref:brand-profile.output.profile.scarcity",
          "body.variables.clientRiskReversal": "$ref:brand-profile.output.profile.riskReversal",
          "body.variables.clientPriceAnchoring": "$ref:brand-profile.output.profile.priceAnchoring",
          "body.variables.clientValueStacking": "$ref:brand-profile.output.profile.valueStacking",
          // Campaign fields from start-run
          "body.variables.targetOutcome": "$ref:start-run.output.targetOutcome",
          "body.variables.valueForTarget": "$ref:start-run.output.valueForTarget",
          // User-provided sales persuasion fields
          "body.variables.urgency": "$ref:start-run.output.urgency",
          "body.variables.scarcity": "$ref:start-run.output.scarcity",
          "body.variables.riskReversal": "$ref:start-run.output.riskReversal",
          "body.variables.socialProof": "$ref:start-run.output.socialProof",
        },
      },
      // Step 5: Send email (non-idempotent, NO RETRY)
      {
        id: "email-send",
        type: "http.call",
        retries: 0, // Non-idempotent send
        config: {
          service: "email-gateway",
          method: "POST",
          path: "/send",
          body: {
            type: "broadcast",
            tag: "cold-email",
            metadata: {
              source: "mcpfactory-campaign-service",
            },
          },
          // Validate that gateway returns success: true (HTTP 200 with success: false is an error)
          validateResponse: { field: "success", equals: true },
        },
        inputMapping: {
          "body.appId": "$ref:start-run.output.appId",
          "body.clerkOrgId": "$ref:start-run.output.clerkOrgId",
          "body.brandId": "$ref:start-run.output.brandId",
          "body.campaignId": "$ref:start-run.output.campaignId",
          "body.runId": "$ref:start-run.output.runId",
          "body.workflowName": "$ref:start-run.output.workflowName",
          "body.to": "$ref:fetch-lead.output.lead.data.email",
          "body.recipientFirstName": "$ref:fetch-lead.output.lead.data.firstName",
          "body.recipientLastName": "$ref:fetch-lead.output.lead.data.lastName",
          "body.recipientCompany": "$ref:fetch-lead.output.lead.data.organizationName",
          "body.subject": "$ref:email-generate.output.subject",
          "body.sequence": "$ref:email-generate.output.sequence",
          "body.metadata.emailGenerationId": "$ref:email-generate.output.id",
        },
      },
      // Step 6: Finalize run (always called — receives leadFound flag)
      {
        id: "end-run",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: {
            success: true,
          },
        },
        inputMapping: {
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
          "body.leadFound": "$ref:fetch-lead.output.found",
        },
      },
      // Error handler: finalize run as failed + re-trigger
      {
        id: "end-run-error",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: {
            success: false,
          },
        },
        inputMapping: {
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
        },
      },
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "fetch-lead" },
      { from: "fetch-lead", to: "check-lead" },
      { from: "check-lead", to: "brand-profile", condition: "results.fetch_lead.found == true" },
      { from: "brand-profile", to: "email-generate" },
      { from: "email-generate", to: "email-send" },
      { from: "check-lead", to: "end-run" },
    ],
    // Error handler: call end-run-error with success=false when any real node fails.
    onError: "end-run-error",
  };
}

export async function deployWorkflows(): Promise<void> {
  const url = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;

  if (!url || !apiKey) {
    console.warn("[Campaign Service] WORKFLOW_SERVICE_URL or WORKFLOW_SERVICE_API_KEY not set, skipping workflow deployment");
    return;
  }

  const res = await fetch(`${url}/workflows/deploy`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      appId: DEFAULT_APP_ID,
      workflows: [
        {
          name: "cold-email-outreach",
          description: "Cold email pipeline: gate checks → lead → generate → send → re-trigger (1 lead per run)",
          dag: buildColdEmailDag(),
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[Campaign Service] Workflow deployment failed (${res.status}):`, body);
    return;
  }

  const data = await res.json() as { workflows?: Array<{ name: string; action: string }> };

  // Store confirmed workflow names from workflow-service response
  if (data.workflows) {
    for (const w of data.workflows) {
      deployedWorkflowNames.set(w.name, w.name);
    }
  }

  console.log("[Campaign Service] Workflows deployed:", data.workflows?.map((w) => `${w.name} (${w.action})`).join(", "));
}

export async function executeCampaignWorkflow(
  type: string,
  inputs: { campaignId: string; clerkOrgId: string; appId: string },
): Promise<void> {
  const url = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;

  console.log(`[Workflow] executeCampaignWorkflow called: type=${type}, campaignId=${inputs.campaignId}, clerkOrgId=${inputs.clerkOrgId}, appId=${inputs.appId}`);

  if (!url || !apiKey) {
    console.warn("[Workflow] WORKFLOW_SERVICE_URL or WORKFLOW_SERVICE_API_KEY not set, skipping workflow execution");
    return;
  }

  const executeUrl = `${url}/workflows/by-name/${type}/execute`;
  console.log(`[Workflow] POST ${executeUrl}`);

  const res = await fetch(executeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      appId: inputs.appId,
      orgId: inputs.clerkOrgId,
      inputs: {
        campaignId: inputs.campaignId,
        clerkOrgId: inputs.clerkOrgId,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[Workflow] Execution failed (${res.status}): ${body}`);
    return;
  }

  const data = await res.json() as { id?: string; status?: string };
  console.log(`[Workflow] ${type} started successfully: workflowRunId=${data.id}, status=${data.status}`);
}

export { buildColdEmailDag };
