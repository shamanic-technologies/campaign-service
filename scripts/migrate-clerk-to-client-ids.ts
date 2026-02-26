/**
 * One-shot migration script: resolve Clerk IDs → client-service UUIDs
 *
 * For each org/user in the local DB, calls client-service to resolve
 * the old Clerk ID to the internal client-service UUID, then updates
 * the local record.
 *
 * Prerequisites:
 *   - DB migration 0018 (column rename) must be applied first
 *   - CLIENT_SERVICE_URL and CLIENT_SERVICE_API_KEY env vars must be set
 *
 * Usage:
 *   CLIENT_SERVICE_URL=https://... CLIENT_SERVICE_API_KEY=... npx tsx scripts/migrate-clerk-to-client-ids.ts
 */

import { db, sql } from "../src/db/index.js";
import { orgs, users } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

const CLIENT_SERVICE_URL = process.env.CLIENT_SERVICE_URL;
const CLIENT_SERVICE_API_KEY = process.env.CLIENT_SERVICE_API_KEY;

if (!CLIENT_SERVICE_URL || !CLIENT_SERVICE_API_KEY) {
  console.error("CLIENT_SERVICE_URL and CLIENT_SERVICE_API_KEY are required");
  process.exit(1);
}

async function resolveOrgId(clerkOrgId: string): Promise<string | null> {
  const res = await fetch(`${CLIENT_SERVICE_URL}/orgs/by-clerk/${encodeURIComponent(clerkOrgId)}`, {
    headers: { "x-api-key": CLIENT_SERVICE_API_KEY! },
  });
  if (!res.ok) {
    console.error(`  Failed to resolve org ${clerkOrgId}: ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { org: { id: string } };
  return data.org.id;
}

async function resolveUserId(clerkUserId: string): Promise<string | null> {
  const res = await fetch(`${CLIENT_SERVICE_URL}/users/by-clerk/${encodeURIComponent(clerkUserId)}`, {
    headers: { "x-api-key": CLIENT_SERVICE_API_KEY! },
  });
  if (!res.ok) {
    console.error(`  Failed to resolve user ${clerkUserId}: ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { user: { id: string } };
  return data.user.id;
}

async function main() {
  console.log("=== Migrating Clerk IDs to client-service UUIDs ===\n");

  // Migrate orgs
  const allOrgs = await db.select().from(orgs);
  console.log(`Found ${allOrgs.length} orgs to migrate`);

  let orgSuccess = 0;
  let orgSkipped = 0;
  let orgFailed = 0;

  for (const org of allOrgs) {
    // Skip if already looks like a UUID (already migrated)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(org.externalOrgId)) {
      orgSkipped++;
      continue;
    }

    const newId = await resolveOrgId(org.externalOrgId);
    if (newId) {
      await db.update(orgs).set({ externalOrgId: newId }).where(eq(orgs.id, org.id));
      console.log(`  org ${org.id}: ${org.externalOrgId} → ${newId}`);
      orgSuccess++;
    } else {
      orgFailed++;
    }
  }

  console.log(`\nOrgs: ${orgSuccess} migrated, ${orgSkipped} skipped (already UUID), ${orgFailed} failed\n`);

  // Migrate users
  const allUsers = await db.select().from(users);
  console.log(`Found ${allUsers.length} users to migrate`);

  let userSuccess = 0;
  let userSkipped = 0;
  let userFailed = 0;

  for (const user of allUsers) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.externalUserId)) {
      userSkipped++;
      continue;
    }

    const newId = await resolveUserId(user.externalUserId);
    if (newId) {
      await db.update(users).set({ externalUserId: newId }).where(eq(users.id, user.id));
      console.log(`  user ${user.id}: ${user.externalUserId} → ${newId}`);
      userSuccess++;
    } else {
      userFailed++;
    }
  }

  console.log(`\nUsers: ${userSuccess} migrated, ${userSkipped} skipped (already UUID), ${userFailed} failed`);
  console.log("\n=== Migration complete ===");

  await sql.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
