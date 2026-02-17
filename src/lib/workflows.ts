const COLD_EMAIL_PROMPT = `You are an expert sales copywriter. Write a personalized cold email for a potential client.

## Recipient Information
{{recipientInfo}}

## Sender / Our Company
{{senderInfo}}

## Reference: Cold Email Frameworks
Use your expertise to craft the email. Here are proven frameworks for reference:

**PAS (Problem-Agitate-Solution)**
Identify a problem, amplify its consequences, present solution.

**BAB (Before-After-Bridge)**
Describe current pain (Before), paint ideal future (After), position solution as the bridge.

**AIDA (Attention-Interest-Desire-Action)**
Hook attention, build interest with value, create desire, end with CTA.

**SPIN (Situation-Problem-Implication-Need-Payoff)**
Acknowledge situation, surface problems, explore implications, highlight payoff.

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

const APP_ID = "mcpfactory";

function buildColdEmailDag() {
  return {
    nodes: [
      {
        id: "register-prompt",
        type: "http.call",
        config: {
          service: "emailgeneration",
          method: "PUT",
          path: "/prompts",
          body: {
            appId: APP_ID,
            type: "cold-email",
            prompt: COLD_EMAIL_PROMPT,
            variables: ["recipientInfo", "senderInfo"],
          },
        },
        inputMapping: {
          "headers.x-clerk-org-id": "$ref:flow_input.clerkOrgId",
        },
      },
      {
        id: "extract-brand",
        type: "http.call",
        config: {
          service: "brand",
          method: "POST",
          path: "/sales-profile",
          body: { appId: APP_ID },
        },
        inputMapping: {
          "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
          "body.url": "$ref:flow_input.brandUrl",
          "body.clerkUserId": "$ref:flow_input.clerkUserId",
          "body.parentRunId": "$ref:flow_input.runId",
        },
      },
      {
        id: "suggest-icp",
        type: "http.call",
        config: {
          service: "brand",
          method: "POST",
          path: "/icp-suggestion",
          body: { appId: APP_ID },
        },
        inputMapping: {
          "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
          "body.url": "$ref:flow_input.brandUrl",
          "body.clerkUserId": "$ref:flow_input.clerkUserId",
          "body.targetAudience": "$ref:flow_input.targetAudience",
        },
      },
      {
        id: "search-leads",
        type: "http.call",
        config: {
          service: "apollo",
          method: "POST",
          path: "/search",
          body: { appId: APP_ID, perPage: 25 },
        },
        inputMapping: {
          "headers.x-clerk-org-id": "$ref:flow_input.clerkOrgId",
          "body.brandId": "$ref:flow_input.brandId",
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.runId": "$ref:flow_input.runId",
          "body.personTitles": "$ref:suggest-icp.output.suggestion.personTitles",
          "body.qOrganizationKeywordTags": "$ref:suggest-icp.output.suggestion.qOrganizationKeywordTags",
          "body.organizationLocations": "$ref:suggest-icp.output.suggestion.organizationLocations",
        },
      },
      {
        id: "process-leads",
        type: "for-each",
        config: {
          iterator: "$ref:search-leads.output.people",
          skipFailures: true,
          dag: {
            nodes: [
              {
                id: "enrich-lead",
                type: "http.call",
                config: {
                  service: "apollo",
                  method: "POST",
                  path: "/enrich",
                  body: { appId: APP_ID },
                },
                inputMapping: {
                  "headers.x-clerk-org-id": "$ref:flow_input.clerkOrgId",
                  "body.apolloPersonId": "$ref:item.id",
                  "body.brandId": "$ref:flow_input.brandId",
                  "body.campaignId": "$ref:flow_input.campaignId",
                  "body.runId": "$ref:flow_input.runId",
                },
              },
              {
                id: "generate-email",
                type: "http.call",
                config: {
                  service: "emailgeneration",
                  method: "POST",
                  path: "/generate",
                  body: { appId: APP_ID, type: "cold-email" },
                },
                inputMapping: {
                  "headers.x-clerk-org-id": "$ref:flow_input.clerkOrgId",
                  "body.runId": "$ref:flow_input.runId",
                  "body.brandId": "$ref:flow_input.brandId",
                  "body.campaignId": "$ref:flow_input.campaignId",
                  "body.apolloEnrichmentId": "$ref:enrich-lead.output.enrichmentId",
                  "body.variables.recipientInfo": "$ref:enrich-lead.output.person",
                  "body.variables.senderInfo": "$ref:flow_input.senderInfo",
                },
              },
              {
                id: "send-email",
                type: "http.call",
                config: {
                  service: "email-gateway",
                  method: "POST",
                  path: "/send",
                  body: { type: "broadcast", appId: APP_ID },
                },
                inputMapping: {
                  "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
                  "body.brandId": "$ref:flow_input.brandId",
                  "body.campaignId": "$ref:flow_input.campaignId",
                  "body.runId": "$ref:flow_input.runId",
                  "body.to": "$ref:enrich-lead.output.person.email",
                  "body.recipientFirstName": "$ref:enrich-lead.output.person.firstName",
                  "body.recipientLastName": "$ref:enrich-lead.output.person.lastName",
                  "body.recipientCompany": "$ref:enrich-lead.output.person.organizationName",
                  "body.subject": "$ref:generate-email.output.subject",
                  "body.htmlBody": "$ref:generate-email.output.bodyHtml",
                  "body.textBody": "$ref:generate-email.output.bodyText",
                },
              },
            ],
            edges: [
              { from: "enrich-lead", to: "generate-email" },
              { from: "generate-email", to: "send-email" },
            ],
          },
        },
      },
    ],
    edges: [
      { from: "register-prompt", to: "extract-brand" },
      { from: "extract-brand", to: "suggest-icp" },
      { from: "suggest-icp", to: "search-leads" },
      { from: "search-leads", to: "process-leads" },
    ],
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
          description: "Full cold email pipeline: prompt → brand → ICP → leads → enrich → generate → send",
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

  const data = await res.json();
  console.log("[Campaign Service] Workflows deployed:", data.workflows?.map((w: { name: string; action: string }) => `${w.name} (${w.action})`).join(", "));
}

interface CampaignWorkflowInputs {
  brandId: string;
  brandUrl: string;
  campaignId: string;
  clerkOrgId: string;
  clerkUserId?: string;
  targetAudience?: string | null;
  targetOutcome?: string | null;
  valueForTarget?: string | null;
  salesProfile?: unknown;
}

export async function executeColdEmailOutreach(inputs: CampaignWorkflowInputs): Promise<void> {
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
        brandId: inputs.brandId,
        brandUrl: inputs.brandUrl,
        campaignId: inputs.campaignId,
        clerkOrgId: inputs.clerkOrgId,
        clerkUserId: inputs.clerkUserId,
        targetAudience: inputs.targetAudience ?? "",
        targetOutcome: inputs.targetOutcome ?? "",
        valueForTarget: inputs.valueForTarget ?? "",
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[Campaign Service] Workflow execution failed (${res.status}):`, body);
    return;
  }

  const data = await res.json();
  console.log(`[Campaign Service] Cold email workflow started: run=${data.id}, status=${data.status}`);
}

export { buildColdEmailDag };
