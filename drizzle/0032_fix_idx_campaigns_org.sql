-- Fix idx_campaigns_org: was created as UNIQUE in 0000 but schema + prod treat it as non-unique.
-- Idempotent: drops then recreates as non-unique btree on (org_id).
DROP INDEX IF EXISTS "idx_campaigns_org";
CREATE INDEX "idx_campaigns_org" ON "campaigns" USING btree ("org_id");
