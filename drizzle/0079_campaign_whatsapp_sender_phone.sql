-- CAMPAIGN-WA-LINE-1028: the linked WhatsApp line (E.164) a campaign writes from, as stated by the customer.
-- NULL = crm-service picks the line as before. Idempotent, boot-safe.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "whatsapp_sender_phone" text;
