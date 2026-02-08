import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");
import healthRoutes from "./routes/health.js";
import campaignsRoutes from "./routes/campaigns.js";
import runsRoutes from "./routes/runs.js";
const app = express();
const PORT = process.env.PORT || 3003;

// Middleware
app.use(cors({
  origin: [
    "https://dashboard.mcpfactory.org",
    "https://mcpfactory.org",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3003",
  ],
  credentials: true,
}));
app.use(express.json());

// Routes
app.use(healthRoutes);
app.use(campaignsRoutes);
app.use(runsRoutes);

// OpenAPI spec endpoint
app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated" });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Sentry error handler must be before any other error middleware
Sentry.setupExpressErrorHandler(app);

// Fallback error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[Campaign Service] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("[Campaign Service] Migrations complete");
      app.listen(Number(PORT), "::", () => {
        console.log(`[Campaign Service] Running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("[Campaign Service] Migration failed:", err);
      process.exit(1);
    });
}

export default app;
