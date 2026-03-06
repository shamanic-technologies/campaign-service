-- Deduplicate existing campaign names within each org by appending " (N)" suffix
WITH duplicates AS (
  SELECT id, org_id, name,
    ROW_NUMBER() OVER (PARTITION BY org_id, name ORDER BY created_at ASC) AS rn
  FROM campaigns
)
UPDATE campaigns
SET name = duplicates.name || ' (' || duplicates.rn || ')'
FROM duplicates
WHERE campaigns.id = duplicates.id AND duplicates.rn > 1;

-- Add unique constraint on (org_id, name)
CREATE UNIQUE INDEX "uniq_campaigns_org_name" ON "campaigns" ("org_id", "name");
