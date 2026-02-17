ALTER TABLE "campaigns" ALTER COLUMN "app_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "target_audience" text;--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "person_titles";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "q_organization_keyword_tags";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "organization_locations";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "organization_num_employees_ranges";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "q_organization_industry_tag_ids";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "q_keywords";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "request_raw";