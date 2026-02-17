import { beforeAll, afterAll, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.CAMPAIGN_SERVICE_DATABASE_URL = process.env.CAMPAIGN_SERVICE_DATABASE_URL || "postgresql://test:test@localhost/test";
process.env.SERVICE_SECRET_KEY = "test-service-secret";
process.env.RUNS_SERVICE_URL = "https://runs.mcpfactory.org";
process.env.RUNS_SERVICE_API_KEY = "test-api-key";
process.env.CAMPAIGN_SERVICE_API_KEY = "test-api-key";
process.env.WINDMILL_SERVICE_URL = "https://windmill.test.local";
process.env.WINDMILL_SERVICE_API_KEY = "test-windmill-key";
process.env.BRAND_SERVICE_URL = "https://brand.test.local";
process.env.BRAND_SERVICE_API_KEY = "test-brand-key";
process.env.LEAD_SERVICE_URL = "https://lead.test.local";
process.env.LEAD_SERVICE_API_KEY = "test-lead-key";
process.env.EMAILGENERATION_SERVICE_URL = "https://emailgen.test.local";
process.env.EMAILGENERATION_SERVICE_API_KEY = "test-emailgen-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "https://email-gateway.test.local";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "test-gateway-key";

beforeAll(() => console.log("Test suite starting..."));
afterAll(() => console.log("Test suite complete."));
