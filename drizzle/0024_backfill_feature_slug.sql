UPDATE "campaigns"
SET "feature_slug" = 'sales-cold-email-outreach',
    "updated_at" = NOW()
WHERE "workflow_name" LIKE 'sales-email-cold-outreach-%'
  AND "feature_slug" IS NULL;