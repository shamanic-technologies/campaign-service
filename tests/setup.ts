import { beforeAll, afterAll, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost/test";
process.env.SERVICE_SECRET_KEY = "test-service-secret";
process.env.RUNS_SERVICE_URL = "https://runs.mcpfactory.org";
process.env.RUNS_SERVICE_API_KEY = "test-api-key";

beforeAll(() => console.log("Test suite starting..."));
afterAll(() => console.log("Test suite complete."));
