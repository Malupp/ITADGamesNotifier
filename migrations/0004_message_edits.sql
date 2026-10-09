ALTER TABLE deliveries ADD COLUMN operation TEXT NOT NULL DEFAULT 'send' CHECK(operation IN ('send','edit'));
ALTER TABLE deliveries ADD COLUMN telegram_message_id INTEGER;
ALTER TABLE deliveries ADD COLUMN view_revision INTEGER;
CREATE INDEX deliveries_message_revision ON deliveries(chat_id,telegram_message_id,view_revision) WHERE operation='edit';
