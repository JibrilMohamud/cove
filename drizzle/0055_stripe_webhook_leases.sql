ALTER TABLE commerce_webhook_events ADD COLUMN processing_token TEXT NOT NULL DEFAULT '';
ALTER TABLE commerce_webhook_events ADD COLUMN processing_lease_until TEXT NOT NULL DEFAULT '';
