-- Rename clerk_org_id -> org_id on orgs table
ALTER TABLE "orgs" RENAME COLUMN "clerk_org_id" TO "org_id";

-- Rename clerk_user_id -> user_id on users table
ALTER TABLE "users" RENAME COLUMN "clerk_user_id" TO "user_id";

-- Drop old indexes
DROP INDEX IF EXISTS "idx_orgs_clerk_id";
DROP INDEX IF EXISTS "idx_users_clerk_id";

-- Recreate indexes with new names
CREATE UNIQUE INDEX IF NOT EXISTS "idx_orgs_org_id" ON "orgs" USING btree ("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_user_id" ON "users" USING btree ("user_id");

-- Rename unique constraints
ALTER TABLE "orgs" RENAME CONSTRAINT "orgs_clerk_org_id_unique" TO "orgs_org_id_unique";
ALTER TABLE "users" RENAME CONSTRAINT "users_clerk_user_id_unique" TO "users_user_id_unique";
