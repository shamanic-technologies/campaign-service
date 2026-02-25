-- Rename type column to workflow_name
ALTER TABLE "campaigns" RENAME COLUMN "type" TO "workflow_name";--> statement-breakpoint

-- Drop sales-specific columns (now owned by brand-service)
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "urgency";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "scarcity";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "risk_reversal";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "social_proof";
