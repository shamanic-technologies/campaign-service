-- Migration: Remove appId, keySource, and local identity tables
-- This migration:
-- 1. Backfills campaigns.org_id with the external org ID from the orgs lookup table
-- 2. Backfills campaigns.created_by_user_id with the external user ID from the users lookup table
-- 3. Converts org_id and created_by_user_id columns from uuid to text
-- 4. Drops app_id and key_source columns
-- 5. Drops the local orgs and users identity tables

-- Step 1: Backfill org_id with external org ID
UPDATE "campaigns"
SET "org_id" = (
  SELECT "orgs"."org_id"
  FROM "orgs"
  WHERE "orgs"."id" = "campaigns"."org_id"::uuid
)
WHERE EXISTS (
  SELECT 1 FROM "orgs" WHERE "orgs"."id" = "campaigns"."org_id"::uuid
);

-- Step 2: Backfill created_by_user_id with external user ID
UPDATE "campaigns"
SET "created_by_user_id" = (
  SELECT "users"."user_id"
  FROM "users"
  WHERE "users"."id" = "campaigns"."created_by_user_id"::uuid
)
WHERE "created_by_user_id" IS NOT NULL
AND EXISTS (
  SELECT 1 FROM "users" WHERE "users"."id" = "campaigns"."created_by_user_id"::uuid
);

-- Step 3: Drop FK constraints and change column types
ALTER TABLE "campaigns" DROP CONSTRAINT IF EXISTS "campaigns_org_id_orgs_id_fk";
ALTER TABLE "campaigns" DROP CONSTRAINT IF EXISTS "campaigns_created_by_user_id_users_id_fk";
ALTER TABLE "campaigns" ALTER COLUMN "org_id" TYPE text;
ALTER TABLE "campaigns" ALTER COLUMN "created_by_user_id" TYPE text;

-- Step 4: Drop app_id column and its index
DROP INDEX IF EXISTS "idx_campaigns_app_id";
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "app_id";

-- Step 5: Drop key_source column
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "key_source";

-- Step 6: Drop local identity tables
DROP TABLE IF EXISTS "users";
DROP TABLE IF EXISTS "orgs";
