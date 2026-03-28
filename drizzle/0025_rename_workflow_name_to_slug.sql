-- Rename workflow_name column to workflow_slug (values unchanged)
ALTER TABLE "campaigns" RENAME COLUMN "workflow_name" TO "workflow_slug";--> statement-breakpoint
