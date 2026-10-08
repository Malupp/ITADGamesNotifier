PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY, username TEXT,
  threshold_cents INTEGER NOT NULL DEFAULT 500 CHECK(threshold_cents >= 0),
  min_cut INTEGER NOT NULL DEFAULT 0 CHECK(min_cut BETWEEN 0 AND 100),
  min_score INTEGER NOT NULL DEFAULT 0 CHECK(min_score BETWEEN 0 AND 100),
  min_discount_pct INTEGER NOT NULL DEFAULT 10 CHECK(min_discount_pct BETWEEN 10 AND 99)
);
CREATE TABLE IF NOT EXISTS wishlist (
  user_id TEXT NOT NULL, game_id TEXT NOT NULL, title TEXT NOT NULL, username TEXT,
  price_at_add_cents INTEGER CHECK(price_at_add_cents >= 0),
  baseline_price_cents INTEGER CHECK(baseline_price_cents >= 0),
  baseline_origin TEXT NOT NULL DEFAULT 'initial',
  last_observed_price_cents INTEGER CHECK(last_observed_price_cents >= 0),
  last_notified_price_cents INTEGER CHECK(last_notified_price_cents >= 0),
  min_discount_pct INTEGER CHECK(min_discount_pct BETWEEN 10 AND 99),
  last_shop TEXT, last_url TEXT, added_at INTEGER NOT NULL,
  last_observed_at INTEGER, last_notified_at INTEGER,
  PRIMARY KEY(user_id, game_id)
);
CREATE INDEX IF NOT EXISTS wishlist_game ON wishlist(game_id);
CREATE TABLE IF NOT EXISTS legacy_sent_slugs (slug TEXT PRIMARY KEY, imported_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS giveaways (
  offer_id TEXT PRIMARY KEY, game_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
  shop TEXT NOT NULL, url TEXT NOT NULL, expires_at INTEGER,
  discovered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS giveaways_expiry ON giveaways(expires_at);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('reply','giveaway','price')),
  chat_id TEXT NOT NULL, text TEXT NOT NULL, reply_markup TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','blocked','expired')),
  attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL,
  lease_until INTEGER, lease_token TEXT, expires_at INTEGER,
  wishlist_user_id TEXT, game_id TEXT, price_cents INTEGER,
  sent_at INTEGER, error_code TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, due_at, lease_until);
CREATE UNIQUE INDEX IF NOT EXISTS wishlist_pending_delivery ON deliveries(wishlist_user_id,game_id)
  WHERE kind='price' AND status IN ('pending','processing');
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','blocked')),
  due_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  lease_until INTEGER, lease_token TEXT, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS updates_due ON telegram_updates(status,due_at,lease_until);
CREATE TABLE IF NOT EXISTS blocked_chats (chat_id TEXT PRIMARY KEY, blocked_at INTEGER NOT NULL);
