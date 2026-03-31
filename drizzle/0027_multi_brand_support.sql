-- Multi-brand support: brand_id TEXT → brand_ids TEXT[]
ALTER TABLE campaigns ADD COLUMN brand_ids TEXT[];
UPDATE campaigns SET brand_ids = ARRAY[brand_id] WHERE brand_id IS NOT NULL;
ALTER TABLE campaigns DROP COLUMN brand_id;
CREATE INDEX idx_campaigns_brand_ids ON campaigns USING GIN (brand_ids);
