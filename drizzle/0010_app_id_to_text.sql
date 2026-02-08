-- Change app_id from uuid to text to support non-UUID identifiers (e.g. "mcpfactory")

ALTER TABLE "campaigns" ALTER COLUMN "app_id" SET DATA TYPE text;
