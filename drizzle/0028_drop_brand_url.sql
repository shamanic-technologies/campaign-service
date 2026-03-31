-- Drop the brand_url column — brandIds is the sole brand reference now
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "brand_url";
