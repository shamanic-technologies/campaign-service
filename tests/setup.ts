import { beforeAll, afterAll, vi } from "vitest";

// Every start path asks billing whether the org's card can be charged (src/lib/payment-hold.ts).
// No test talks to billing, so the fleet default here is "not held"; the payment-hold tests
// override it per case, and its own unit test reads the real module via vi.importActual.
vi.mock("../src/lib/payment-hold.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/payment-hold.js")>();
  return {
    ...original,
    readPaymentHold: vi.fn().mockResolvedValue({ ok: true, held: false }),
    paymentStartRefusal: vi.fn().mockResolvedValue(null),
  };
});

// SOURCE CAMPAIGNS (src/lib/source-campaign-store.ts): the outreach spend read also counts the
// offer's source campaigns, and a person's first outreach start may birth a default source (which
// reads the catalogue). Tests that are not about sources see neither; the source tests use
// vi.importActual (tests/unit/source-campaigns.test.ts, tests/integration/source-campaigns.test.ts).
vi.mock("../src/lib/source-campaign-store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/source-campaign-store.js")>();
  return {
    ...original,
    sourceCampaignsFeeding: vi.fn().mockResolvedValue([]),
    ensureSourcesOnStart: vi.fn().mockResolvedValue([]),
  };
});

// WHO DISPATCHES A PIPE (src/lib/on-demand-mode.ts) is read on the catalogue at every claim and person start. Tests
// that are not about it read it as unreadable (sources parked on demand, everything else runs: today's behaviour);
// the on-demand tests state their own reading.
vi.mock("../src/lib/on-demand-mode.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/on-demand-mode.js")>();
  return { ...original, readDispatchCatalogue: vi.fn().mockResolvedValue({ ok: false, detail: "not read in tests" }) };
});

process.env.NODE_ENV = "test";
process.env.CAMPAIGN_SERVICE_DATABASE_URL = process.env.CAMPAIGN_SERVICE_DATABASE_URL || "postgresql://test:test@localhost/campaign_test";
process.env.SERVICE_SECRET_KEY = "test-service-secret";
process.env.RUNS_SERVICE_URL = "https://runs.distribute.you";
process.env.RUNS_SERVICE_API_KEY = "test-api-key";
process.env.CAMPAIGN_SERVICE_API_KEY = "test-api-key";
process.env.WORKFLOW_SERVICE_URL = "https://workflow.test.local";
process.env.WORKFLOW_SERVICE_API_KEY = "test-workflow-key";
process.env.LEAD_SERVICE_URL = "https://lead.test.local";
process.env.LEAD_SERVICE_API_KEY = "test-lead-key";
process.env.FEATURES_SERVICE_URL = "https://features.test.local";
process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
process.env.BRAND_SERVICE_URL = "https://brand.test.local";
process.env.BRAND_SERVICE_API_KEY = "test-brand-key";

beforeAll(() => console.log("Test suite starting..."));
afterAll(() => console.log("Test suite complete."));
