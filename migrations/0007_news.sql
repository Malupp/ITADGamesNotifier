CREATE TABLE news_groups (
  chat_id TEXT PRIMARY KEY,
  chat_type TEXT NOT NULL CHECK(chat_type IN ('group','supergroup')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  activated_at INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  last_update_id INTEGER NOT NULL DEFAULT -1,
  last_received_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  topic_cursor INTEGER NOT NULL DEFAULT 0,
  source_cursors TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE news_feeds (
  id TEXT PRIMARY KEY, seeded INTEGER NOT NULL DEFAULT 0,
  etag TEXT, last_modified TEXT, fetched_at INTEGER NOT NULL,
  last_cycle INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE news_articles (
  id TEXT PRIMARY KEY, publisher TEXT NOT NULL, source_name TEXT NOT NULL,
  topic TEXT NOT NULL CHECK(topic IN ('games','cinema','anime_manga')),
  title TEXT NOT NULL, url TEXT NOT NULL, published_at INTEGER NOT NULL,
  eligible INTEGER NOT NULL, discovered_at INTEGER NOT NULL,
  guid TEXT, cycle_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX news_articles_recent ON news_articles(eligible,published_at);
CREATE TABLE news_jobs (
  id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, cycle_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', due_at INTEGER NOT NULL,
  enqueued_at INTEGER, lease_until INTEGER, lease_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  UNIQUE(feed_id,cycle_at)
);
CREATE INDEX news_jobs_due ON news_jobs(status,due_at);
CREATE TABLE news_deliveries (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, article_id TEXT NOT NULL,
  generation INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  due_at INTEGER NOT NULL, enqueued_at INTEGER, lease_until INTEGER,
  lease_token TEXT, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER,
  UNIQUE(chat_id,article_id)
);
CREATE INDEX news_deliveries_due ON news_deliveries(status,due_at);
CREATE INDEX news_deliveries_group ON news_deliveries(chat_id,status);
CREATE TABLE news_send_attempts (
  id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE INDEX news_attempts_window ON news_send_attempts(chat_id,started_at);
