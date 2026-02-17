export const COLD_EMAIL_PROMPT = `You are an expert sales copywriter. Write a personalized cold email for a potential client.

## Recipient Information
- Name: {{leadFirstName}} {{leadLastName}}
- Title: {{leadTitle}}
- Email: {{leadEmail}}
- LinkedIn: {{leadLinkedinUrl}}
- Company: {{leadCompanyName}}
- Domain: {{leadCompanyDomain}}
- Industry: {{leadCompanyIndustry}}
- Company Size: {{leadCompanySize}} employees
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
 * Pipeline: start-run → email-generate → email-send → end-run
 *
 * - start-run: gate checks + create run + campaign/brand/lead fetch (campaign-service internal)
 * - email-generate: generate email via AI (emailgeneration-service, NO RETRY)
 * - email-send: send email (email-gateway-service, NO RETRY, validate success field)
 * - end-run: finalize run + re-trigger (campaign-service internal)
 *
 * On DAG error: end-run is called with success=false via onError handler.
 */
function buildColdEmailDag() {
  return {
    nodes: [
      // Step 1–4: Gate checks + create run + fetch campaign + brand profile + lead
      {
        id: "start-run",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/internal/start-run",
          retries: 0, // Contains non-idempotent lead fetch
        },
        inputMapping: {
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
        },
      },
      // Step 5: Generate email (non-idempotent, NO RETRY)
      {
        id: "email-generate",
        type: "http.call",
        config: {
          service: "emailgeneration",
          method: "POST",
          path: "/generate",
          retries: 0,
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
          "body.apolloEnrichmentId": "$ref:start-run.output.lead.externalId",
          // Lead fields
          "body.leadFirstName": "$ref:start-run.output.lead.data.first_name",
          "body.leadLastName": "$ref:start-run.output.lead.data.last_name",
          "body.leadTitle": "$ref:start-run.output.lead.data.title",
          "body.leadEmail": "$ref:start-run.output.lead.data.email",
          "body.leadLinkedinUrl": "$ref:start-run.output.lead.data.linkedin_url",
          "body.leadCompanyName": "$ref:start-run.output.lead.data.organization_name",
          "body.leadCompanyDomain": "$ref:start-run.output.lead.data.organization.primary_domain",
          "body.leadCompanyIndustry": "$ref:start-run.output.lead.data.organization.industry",
          "body.leadCompanySize": "$ref:start-run.output.lead.data.organization.estimated_num_employees",
          "body.leadCompanyRevenueUsd": "$ref:start-run.output.lead.data.organization.annual_revenue_printed",
          // Client/brand fields
          "body.clientCompanyName": "$ref:start-run.output.clientData.companyName",
          "body.clientBrandUrl": "$ref:start-run.output.clientData.brandUrl",
          "body.clientCompanyOverview": "$ref:start-run.output.clientData.companyOverview",
          "body.clientValueProposition": "$ref:start-run.output.clientData.valueProposition",
          "body.clientTargetAudience": "$ref:start-run.output.clientData.targetAudience",
          "body.clientCustomerPainPoints": "$ref:start-run.output.clientData.customerPainPoints",
          "body.clientKeyFeatures": "$ref:start-run.output.clientData.keyFeatures",
          "body.clientProductDifferentiators": "$ref:start-run.output.clientData.productDifferentiators",
          "body.clientCompetitors": "$ref:start-run.output.clientData.competitors",
          "body.clientSocialProof": "$ref:start-run.output.clientData.socialProof",
          "body.clientCallToAction": "$ref:start-run.output.clientData.callToAction",
          "body.clientAdditionalContext": "$ref:start-run.output.clientData.additionalContext",
          // Campaign fields
          "body.targetOutcome": "$ref:start-run.output.targetOutcome",
          "body.valueForTarget": "$ref:start-run.output.valueForTarget",
        },
      },
      // Step 6: Send email (non-idempotent, NO RETRY)
      {
        id: "email-send",
        type: "http.call",
        config: {
          service: "email-gateway",
          method: "POST",
          path: "/send",
          retries: 0,
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
          "body.to": "$ref:start-run.output.lead.data.email",
          "body.recipientFirstName": "$ref:start-run.output.lead.data.first_name",
          "body.recipientLastName": "$ref:start-run.output.lead.data.last_name",
          "body.recipientCompany": "$ref:start-run.output.lead.data.organization_name",
          "body.subject": "$ref:email-generate.output.subject",
          "body.htmlBody": "$ref:email-generate.output.bodyHtml",
          "body.metadata.emailGenerationId": "$ref:email-generate.output.id",
        },
      },
      // Step 7: Finalize run + re-trigger
      {
        id: "end-run",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/internal/end-run",
          body: {
            success: true,
          },
        },
        inputMapping: {
          "body.runId": "$ref:start-run.output.runId",
          "body.campaignId": "$ref:start-run.output.campaignId",
          "body.clerkOrgId": "$ref:start-run.output.clerkOrgId",
        },
      },
    ],
    edges: [
      { from: "start-run", to: "email-generate" },
      { from: "email-generate", to: "email-send" },
      { from: "email-send", to: "end-run" },
    ],
    // Error handler: call end-run with success=false when any node fails.
    onError: "end-run",
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

export async function executeColdEmailOutreach(inputs: {
  campaignId: string;
  clerkOrgId: string;
}): Promise<void> {
  const url = process.env.WINDMILL_SERVICE_URL;
  const apiKey = process.env.WINDMILL_SERVICE_API_KEY;

  if (!url || !apiKey) {
    console.warn("[Campaign Service] WINDMILL_SERVICE_URL or WINDMILL_SERVICE_API_KEY not set, skipping workflow execution");
    return;
  }

  const res = await fetch(`${url}/workflows/by-name/cold-email-outreach/execute`, {
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
    console.error(`[Campaign Service] Workflow execution failed (${res.status}):`, body);
    return;
  }

  const data = await res.json() as { id?: string; status?: string };
  console.log(`[Campaign Service] Cold email workflow started: run=${data.id}, status=${data.status}`);
}

export { buildColdEmailDag };
