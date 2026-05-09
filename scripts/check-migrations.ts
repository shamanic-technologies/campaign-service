import { join } from "node:path";
import { validateMigrationsJournal } from "../src/lib/migrations-validator.js";

const migrationsDir = join(process.cwd(), "drizzle");
const result = validateMigrationsJournal({ migrationsDir });

if (result.errors.length > 0) {
  console.error("[campaign-service] Migration journal drift detected:");
  for (const err of result.errors) {
    console.error(`[campaign-service]   - ${err}`);
  }
  console.error(
    "[campaign-service] Fix: regenerate journal with `pnpm run db:generate` or hand-edit drizzle/meta/_journal.json to match drizzle/*.sql files.",
  );
  process.exit(1);
}

console.log("[campaign-service] Migration journal: OK");
