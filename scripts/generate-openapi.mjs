import swaggerAutogen from "swagger-autogen";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const doc = {
  info: {
    title: "Campaign Service",
    description: "API for managing marketing campaigns, runs, and internal service-to-service communication",
    version: "1.0.0",
  },
  host: process.env.SERVICE_URL || "http://localhost:3003",
  basePath: "/",
  schemes: ["https"],
};

const outputFile = join(projectRoot, "openapi.json");
const routes = [join(projectRoot, "src/index.ts")];

swaggerAutogen({ openapi: "3.0.0" })(outputFile, routes, doc);
