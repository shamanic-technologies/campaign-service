import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { restorePostgresArrayTypes } from "./postgres-array-types.js";
import { restoreDriverErrorMessages } from "../lib/pg-error.js";

const connectionString = process.env.CAMPAIGN_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("CAMPAIGN_SERVICE_DATABASE_URL is not set");
}

export const sql = postgres(connectionString);
export const db = drizzle(sql, { schema });
// drizzle-orm >= 0.41/0.44 runtime changes, restored to their 0.36 behaviour:
// date[]/timestamp[]/numeric[] back to postgres.js, and a failed query's message is the database's
// own again (no SQL text or bound values in what we answer with or store).
restorePostgresArrayTypes(sql);
restoreDriverErrorMessages();
