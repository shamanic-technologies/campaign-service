/**
 * One-shot migration script: resolve Clerk IDs → client-service UUIDs
 *
 * For each org/user in the local lookup tables, calls client-service to
 * resolve the Clerk ID to the internal client-service UUID, then updates
 * the local record. After this script runs, migration 0019 can safely
 * backfill campaigns and drop the lookup tables.
 *
 * Prerequisites:
 *   - DB migration 0018 (column rename) must be applied first
 *   - Environment variables: CAMPAIGN_SERVICE_DATABASE_URL, CLIENT_SERVICE_URL, CLIENT_SERVICE_API_KEY
 *
 * Usage:
 *   CAMPAIGN_SERVICE_DATABASE_URL=... CLIENT_SERVICE_URL=... CLIENT_SERVICE_API_KEY=... npx tsx scripts/migrate-clerk-to-client-ids.ts
 */

import postgres from "postgres";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makeResolver(baseUrl: string, apiKey: string) {
  async function resolveOrgId(clerkOrgId: string): Promise<string | null> {
    const res = await fetch(
      `${baseUrl}/orgs/by-clerk/${encodeURIComponent(clerkOrgId)}`,
      { headers: { "x-api-key": apiKey } },
    );
    if (!res.ok) {
      console.error(`  Failed to resolve org ${clerkOrgId}: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { org: { id: string } };
    return data.org.id;
  }

  async function resolveUserId(clerkUserId: string): Promise<string | null> {
    const res = await fetch(
      `${baseUrl}/users/by-clerk/${encodeURIComponent(clerkUserId)}`,
      { headers: { "x-api-key": apiKey } },
    );
    if (!res.ok) {
      console.error(`  Failed to resolve user ${clerkUserId}: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { user: { id: string } };
    return data.user.id;
  }

  return { resolveOrgId, resolveUserId };
}

export async function migrateOrgs(
  querySql: postgres.Sql,
  resolve: (clerkId: string) => Promise<string | null>,
): Promise<{ success: number; skipped: number; failed: number }> {
  const allOrgs = await querySql`SELECT id, org_id FROM orgs`;
  console.log(`Found ${allOrgs.length} orgs to migrate`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const org of allOrgs) {
    if (UUID_RE.test(org.org_id)) {
      skipped++;
      continue;
    }

    const newId = await resolve(org.org_id);
    if (newId) {
      await querySql`UPDATE orgs SET org_id = ${newId} WHERE id = ${org.id}`;
      console.log(`  org ${org.id}: ${org.org_id} → ${newId}`);
      success++;
    } else {
      failed++;
    }
  }

  return { success, skipped, failed };
}

export async function migrateUsers(
  querySql: postgres.Sql,
  resolve: (clerkId: string) => Promise<string | null>,
): Promise<{ success: number; skipped: number; failed: number }> {
  const allUsers = await querySql`SELECT id, user_id FROM users`;
  console.log(`Found ${allUsers.length} users to migrate`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const user of allUsers) {
    if (UUID_RE.test(user.user_id)) {
      skipped++;
      continue;
    }

    const newId = await resolve(user.user_id);
    if (newId) {
      await querySql`UPDATE users SET user_id = ${newId} WHERE id = ${user.id}`;
      console.log(`  user ${user.id}: ${user.user_id} → ${newId}`);
      success++;
    } else {
      failed++;
    }
  }

  return { success, skipped, failed };
}

async function main() {
  const DATABASE_URL = process.env.CAMPAIGN_SERVICE_DATABASE_URL;
  const CLIENT_SERVICE_URL = process.env.CLIENT_SERVICE_URL;
  const CLIENT_SERVICE_API_KEY = process.env.CLIENT_SERVICE_API_KEY;

  if (!DATABASE_URL || !CLIENT_SERVICE_URL || !CLIENT_SERVICE_API_KEY) {
    console.error("Required: CAMPAIGN_SERVICE_DATABASE_URL, CLIENT_SERVICE_URL, CLIENT_SERVICE_API_KEY");
    process.exit(1);
  }

  const sql = postgres(DATABASE_URL);
  const { resolveOrgId, resolveUserId } = makeResolver(CLIENT_SERVICE_URL, CLIENT_SERVICE_API_KEY);

  console.log("=== Migrating Clerk IDs to client-service UUIDs ===\n");

  // Check if tables exist
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('orgs', 'users')
  `;
  const tableNames = new Set(tables.map((t) => t.table_name));

  if (tableNames.has("orgs")) {
    const orgResult = await migrateOrgs(sql, resolveOrgId);
    console.log(`\nOrgs: ${orgResult.success} migrated, ${orgResult.skipped} skipped, ${orgResult.failed} failed\n`);
    if (orgResult.failed > 0) {
      console.error("ABORTING: some orgs failed to resolve");
      await sql.end();
      process.exit(1);
    }
  } else {
    console.log("orgs table does not exist — already migrated\n");
  }

  if (tableNames.has("users")) {
    const userResult = await migrateUsers(sql, resolveUserId);
    console.log(`\nUsers: ${userResult.success} migrated, ${userResult.skipped} skipped, ${userResult.failed} failed`);
    if (userResult.failed > 0) {
      console.error("ABORTING: some users failed to resolve");
      await sql.end();
      process.exit(1);
    }
  } else {
    console.log("users table does not exist — already migrated");
  }

  console.log("\n=== Resolution complete ===");
  await sql.end();
}

// Only run main() when executed directly (not imported in tests)
const isDirectRun = process.argv[1]?.includes("migrate-clerk-to-client-ids");
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
