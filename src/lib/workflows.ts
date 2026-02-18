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
- Social Proof: {{clientSocialProof}}
- CTA: {{clientCallToAction}}
- Additional Context: {{clientAdditionalContext}}

## Campaign Goals
- Target Outcome: {{targetOutcome}}
- Value for Target: {{valueForTarget}}

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
  "leadFirstName", "leadLastName", "leadTitle", "leadEmail",
  "leadLinkedinUrl", "leadCompanyName", "leadCompanyDomain",
  "leadCompanyIndustry", "leadCompanySize", "leadCompanyRevenueUsd",
  "clientCompanyName", "clientBrandUrl", "clientCompanyOverview",
  "clientValueProposition", "clientTargetAudience", "clientCustomerPainPoints",
  "clientKeyFeatures", "clientProductDifferentiators", "clientCompetitors",
  "clientSocialProof", "clientCallToAction", "clientAdditionalContext",
  "targetOutcome", "valueForTarget",
];

const APP_ID = "mcpfactory";

/**
 * Build the cold-email-outreach DAG.
 *
 * Pipeline:
 *   gate-check → start-run → brand-profile ↘
 *                                            → email-generate → email-send → end-run
 *                          → fetch-lead    ↗
 *
 * - gate-check:     validate budget/volume/status limits (campaign-service)
 * - start-run:      create run + return campaign data (campaign-service)
 * - brand-profile:  fetch brand sales profile (brand-service)
 * - fetch-lead:     pull next lead from buffer (lead-service, NO RETRY)
 * - email-generate: generate email via AI (emailgeneration-service, NO RETRY)
 * - email-send:     send email (email-gateway-service, NO RETRY, validate success)
 * - end-run:        finalize run as completed + re-trigger (campaign-service)
 * - end-run-error:  finalize run as failed + re-trigger (campaign-service, onError handler)
 *
 * brand-profile and fetch-lead run in parallel after start-run.
 * On DAG error: end-run-error is called with success=false via onError handler.
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
      // Step 2a: Fetch brand sales profile (parallel with fetch-lead)
      {
        id: "brand-profile",
        type: "http.call",
        config: {
          service: "brand",
          method: "POST",
          path: "/sales-profile",
          body: {
            keyType: "byok",
          },
        },
        inputMapping: {
          "body.appId": "$ref:start-run.output.appId",
          "body.clerkOrgId": "$ref:start-run.output.clerkOrgId",
          "body.url": "$ref:start-run.output.brandUrl",
          "body.clerkUserId": "$ref:start-run.output.clerkUserId",
          "body.parentRunId": "$ref:start-run.output.runId",
        },
      },
      // Step 2b: Pull next lead from buffer (parallel with brand-profile)
      {
        id: "fetch-lead",
        type: "http.call",
        retries: 0, // Non-idempotent: consumes from buffer
        config: {
          service: "lead",
          method: "POST",
          path: "/buffer/next",
          body: {
            keySource: "byok",
          },
          validateResponse: { field: "found", equals: true },
        },
        inputMapping: {
          "headers.x-app-id": "$ref:start-run.output.appId",
          "headers.x-org-id": "$ref:start-run.output.clerkOrgId",
          "body.campaignId": "$ref:start-run.output.campaignId",
          "body.brandId": "$ref:start-run.output.brandId",
          "body.parentRunId": "$ref:start-run.output.runId",
          "body.searchParams": "$ref:start-run.output.searchParams",
        },
      },
      // Step 3: Generate email (non-idempotent, NO RETRY)
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
          "body.apolloEnrichmentId": "$ref:fetch-lead.output.lead.externalId",
          // Lead fields from fetch-lead (flat camelCase per Apollo spec)
          "body.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
          "body.leadLastName": "$ref:fetch-lead.output.lead.data.lastName",
          "body.leadTitle": "$ref:fetch-lead.output.lead.data.title",
          "body.leadEmail": "$ref:fetch-lead.output.lead.data.email",
          "body.leadLinkedinUrl": "$ref:fetch-lead.output.lead.data.linkedinUrl",
          "body.leadCompanyName": "$ref:fetch-lead.output.lead.data.organizationName",
          "body.leadCompanyDomain": "$ref:fetch-lead.output.lead.data.organizationDomain",
          "body.leadCompanyIndustry": "$ref:fetch-lead.output.lead.data.organizationIndustry",
          "body.leadCompanySize": "$ref:fetch-lead.output.lead.data.organizationSize",
          "body.leadCompanyRevenueUsd": "$ref:fetch-lead.output.lead.data.organizationRevenueUsd",
          // Client/brand fields from brand-profile
          "body.clientCompanyName": "$ref:start-run.output.brandDomain",
          "body.clientBrandUrl": "$ref:start-run.output.brandUrl",
          "body.clientCompanyOverview": "$ref:brand-profile.output.profile.companyOverview",
          "body.clientValueProposition": "$ref:brand-profile.output.profile.valueProposition",
          "body.clientTargetAudience": "$ref:brand-profile.output.profile.targetAudience",
          "body.clientCustomerPainPoints": "$ref:brand-profile.output.profile.customerPainPoints",
          "body.clientKeyFeatures": "$ref:brand-profile.output.profile.keyFeatures",
          "body.clientProductDifferentiators": "$ref:brand-profile.output.profile.productDifferentiators",
          "body.clientCompetitors": "$ref:brand-profile.output.profile.competitors",
          "body.clientSocialProof": "$ref:brand-profile.output.profile.socialProof",
          "body.clientCallToAction": "$ref:brand-profile.output.profile.callToAction",
          "body.clientAdditionalContext": "$ref:brand-profile.output.profile.additionalContext",
          // Campaign fields from start-run
          "body.targetOutcome": "$ref:start-run.output.targetOutcome",
          "body.valueForTarget": "$ref:start-run.output.valueForTarget",
        },
      },
      // Step 4: Send email (non-idempotent, NO RETRY)
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
          "body.to": "$ref:fetch-lead.output.lead.data.email",
          "body.recipientFirstName": "$ref:fetch-lead.output.lead.data.firstName",
          "body.recipientLastName": "$ref:fetch-lead.output.lead.data.lastName",
          "body.recipientCompany": "$ref:fetch-lead.output.lead.data.organizationName",
          "body.subject": "$ref:email-generate.output.subject",
          "body.htmlBody": "$ref:email-generate.output.bodyHtml",
          "body.metadata.emailGenerationId": "$ref:email-generate.output.id",
        },
      },
      // Step 5: Finalize run as completed + re-trigger
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
      { from: "start-run", to: "brand-profile" },
      { from: "start-run", to: "fetch-lead" },
      { from: "brand-profile", to: "email-generate" },
      { from: "fetch-lead", to: "email-generate" },
      { from: "email-generate", to: "email-send" },
      { from: "email-send", to: "end-run" },
    ],
    // Error handler: call end-run-error with success=false when any node fails.
    onError: "end-run-error",
  };
}

export async function deployWorkflows(): Promise<void> {
  const url = process.env.WINDMILL_SERVICE_URL;
  const apiKey = process.env.WINDMILL_SERVICE_API_KEY;

  if (!url || !apiKey) {
    console.warn("[Campaign Service] WINDMILL_SERVICE_URL or WINDMILL_SERVICE_API_KEY not set, skipping workflow deployment");
    return;
  }

  const res = await fetch(`${url}/workflows/deploy`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      appId: APP_ID,
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
  console.log("[Campaign Service] Workflows deployed:", data.workflows?.map((w) => `${w.name} (${w.action})`).join(", "));
}

export async function executeCampaignWorkflow(
  type: string,
  inputs: { campaignId: string; clerkOrgId: string },
): Promise<void> {
  const url = process.env.WINDMILL_SERVICE_URL;
  const apiKey = process.env.WINDMILL_SERVICE_API_KEY;

  console.log(`[Workflow] executeCampaignWorkflow called: type=${type}, campaignId=${inputs.campaignId}, clerkOrgId=${inputs.clerkOrgId}`);

  if (!url || !apiKey) {
    console.warn("[Workflow] WINDMILL_SERVICE_URL or WINDMILL_SERVICE_API_KEY not set, skipping workflow execution");
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
      appId: APP_ID,
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
  console.log(`[Workflow] ${type} started successfully: windmillRunId=${data.id}, status=${data.status}`);
}

export { buildColdEmailDag };
