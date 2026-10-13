-- Durable media survives Queue retries and gallery navigation.
ALTER TABLE deliveries ADD COLUMN reply_media TEXT;
