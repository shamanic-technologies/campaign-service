-- Drop the dead campaign attribution column customer_persona_id.
-- customerPersonaId was a pure pass-through dimension (threaded header-to-header
-- and stored) but aggregated nowhere — never grouped/filtered/keyed for cost or
-- stats in runs-service or features-service. Fully superseded by audience_id.
-- Idempotent + boot-safe: only drops when the column still exists.
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "customer_persona_id";
