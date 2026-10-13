-- Group subscriptions remain archived; nobody is opted in by this migration.
CREATE TABLE private_users (
  user_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  recent_deals_enabled INTEGER NOT NULL DEFAULT 0 CHECK(recent_deals_enabled IN (0,1)),
  recent_deals_revision INTEGER NOT NULL DEFAULT 0,
  recent_deals_generation INTEGER NOT NULL DEFAULT 0,
  recent_deals_update_id INTEGER NOT NULL DEFAULT -1,
  recent_deals_received_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO private_users(user_id,started_at,last_seen_at)
SELECT user_id,min(added_at),max(added_at) FROM wishlist
WHERE CAST(user_id AS INTEGER)>0 GROUP BY user_id;
INSERT OR IGNORE INTO private_users(user_id,started_at,last_seen_at)
SELECT user_id,0,0 FROM user_prefs WHERE CAST(user_id AS INTEGER)>0;

CREATE TABLE news_subscribers (
  chat_id TEXT PRIMARY KEY REFERENCES private_users(user_id),
  chat_type TEXT NOT NULL DEFAULT 'private' CHECK(chat_type='private'),
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
CREATE INDEX news_subscribers_enabled ON news_subscribers(enabled,chat_id);
CREATE INDEX private_users_recent ON private_users(recent_deals_enabled,user_id);
UPDATE news_groups SET enabled=0,generation=generation+1,revision=revision+1;
UPDATE news_deliveries SET status='expired',lease_token=NULL,lease_until=NULL
WHERE status IN ('pending','processing');
UPDATE deliveries SET status='expired',lease_token=NULL,lease_until=NULL
WHERE status IN ('pending','processing') AND
  (source='keydeal' OR (CAST(chat_id AS INTEGER)<0 AND kind!='giveaway'));

ALTER TABLE news_articles ADD COLUMN summary TEXT;
ALTER TABLE news_articles ADD COLUMN image_url TEXT;
ALTER TABLE news_deliveries ADD COLUMN media_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE giveaways ADD COLUMN description TEXT;
ALTER TABLE giveaways ADD COLUMN image_url TEXT;
ALTER TABLE giveaways ADD COLUMN genres TEXT;
