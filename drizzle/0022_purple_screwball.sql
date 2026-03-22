CREATE TABLE IF NOT EXISTS "discovered_journalists" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"outlet_name" text,
	"title" text,
	"beat" text,
	"linkedin_url" text,
	"twitter_handle" text,
	"location" text,
	"domain_rating" numeric(5, 1),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discovered_outlets" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text,
	"url" text,
	"domain_rating" numeric(5, 1),
	"monthly_traffic" integer,
	"topics" text[] DEFAULT '{}' NOT NULL,
	"country" text,
	"language" text,
	"contact_email" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovered_journalists" ADD CONSTRAINT "discovered_journalists_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovered_outlets" ADD CONSTRAINT "discovered_outlets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_discovered_journalists_campaign" ON "discovered_journalists" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_discovered_outlets_campaign" ON "discovered_outlets" USING btree ("campaign_id");