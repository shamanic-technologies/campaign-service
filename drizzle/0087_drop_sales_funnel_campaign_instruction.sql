-- Drop the legacy `sales_funnel_campaigns.instruction` (owner 2026-11-05, ONE-BRIEF-1105-REMOVE): a campaign has ONE
-- text, its brief. Migration 0086 folded every instruction into its brief; workflow-service, content-generation-service
-- and chat-service read/write only the brief on origin/main; the API refuses `instruction` (400 `instruction_retired`).
--
-- In production on 2026-11-05: 120 rows, 20 carrying an instruction, 0 not folded into their brief. Steps, guarded on
-- the column (a replay is a no-op): (1) fold again any instruction written since 0086 (same rule as 0086: brief first,
-- instruction appended as its own paragraph, no brief = the instruction; a brief already holding it is untouched);
-- (2) snapshot every row carrying one (history is never rewritten without a copy); (3) drop the column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_funnel_campaigns' AND column_name = 'instruction'
  ) THEN
    UPDATE "sales_funnel_campaigns"
    SET "brief" = CASE
          WHEN "brief" IS NULL OR btrim("brief") = '' THEN "instruction"
          ELSE "brief" || E'\n\n' || "instruction"
        END,
        "brief_updated_at" = now(),
        "brief_updated_by_user_id" = NULL,
        "updated_at" = now()
    WHERE "instruction" IS NOT NULL
      AND btrim("instruction") <> ''
      AND ("brief" IS NULL OR strpos("brief", "instruction") = 0);

    CREATE TABLE IF NOT EXISTS "sales_funnel_campaigns_instruction_snapshot_20261105" (
      "sales_funnel_campaign_id" text PRIMARY KEY,
      "instruction" text NOT NULL,
      "snapshotted_at" timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO "sales_funnel_campaigns_instruction_snapshot_20261105" ("sales_funnel_campaign_id", "instruction")
    SELECT "id"::text, "instruction" FROM "sales_funnel_campaigns" WHERE "instruction" IS NOT NULL
    ON CONFLICT ("sales_funnel_campaign_id") DO NOTHING;

    ALTER TABLE "sales_funnel_campaigns" DROP COLUMN "instruction";
  END IF;
END $$;
