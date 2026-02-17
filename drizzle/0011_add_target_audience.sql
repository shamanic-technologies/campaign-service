-- Add target_audience column
ALTER TABLE "campaigns" ADD COLUMN "target_audience" text;

-- Backfill: concatenate existing Apollo fields into target_audience
UPDATE "campaigns" SET "target_audience" = CONCAT_WS('; ',
  CASE WHEN "person_titles" IS NOT NULL THEN 'Titles: ' || array_to_string("person_titles", ', ') END,
  CASE WHEN "organization_locations" IS NOT NULL THEN 'Locations: ' || array_to_string("organization_locations", ', ') END,
  CASE WHEN "q_organization_keyword_tags" IS NOT NULL THEN 'Keywords: ' || array_to_string("q_organization_keyword_tags", ', ') END,
  CASE WHEN "organization_num_employees_ranges" IS NOT NULL THEN 'Employees: ' || array_to_string("organization_num_employees_ranges", ', ') END,
  CASE WHEN "q_organization_industry_tag_ids" IS NOT NULL THEN 'Industries: ' || array_to_string("q_organization_industry_tag_ids", ', ') END,
  CASE WHEN "q_keywords" IS NOT NULL THEN 'Search: ' || "q_keywords" END
)
WHERE "person_titles" IS NOT NULL
   OR "organization_locations" IS NOT NULL
   OR "q_organization_keyword_tags" IS NOT NULL
   OR "organization_num_employees_ranges" IS NOT NULL
   OR "q_organization_industry_tag_ids" IS NOT NULL
   OR "q_keywords" IS NOT NULL;

-- Drop Apollo columns
ALTER TABLE "campaigns" DROP COLUMN "person_titles";
ALTER TABLE "campaigns" DROP COLUMN "q_organization_keyword_tags";
ALTER TABLE "campaigns" DROP COLUMN "organization_locations";
ALTER TABLE "campaigns" DROP COLUMN "organization_num_employees_ranges";
ALTER TABLE "campaigns" DROP COLUMN "q_organization_industry_tag_ids";
ALTER TABLE "campaigns" DROP COLUMN "q_keywords";
ALTER TABLE "campaigns" DROP COLUMN "request_raw";
