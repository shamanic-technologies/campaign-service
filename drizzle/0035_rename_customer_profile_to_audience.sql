-- Rename the deprecated campaign attribution column customer_profile_id → audience_id.
-- audience_id holds the human-service saved-filter-set UUID (== audience.id). The old
-- customerProfileId vocabulary is purged fleet-wide; this column is its last home here.
-- Idempotent + boot-safe: only renames when the old column still exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'customer_profile_id'
  ) THEN
    ALTER TABLE "campaigns" RENAME COLUMN "customer_profile_id" TO "audience_id";
  END IF;
END $$;
