import type {
  Delivery,
  Game,
  Offer,
  Preferences,
  PriceQuote,
  TelegramUpdate,
  WishlistItem,
} from "../../domain/models.js";
import { effectiveThreshold } from "../../domain/pricing.js";
import {
  escapeHtml,
  formatGiveaway,
  money,
} from "../../telegram/formatters.js";

export class GiveawaysRepository {
  constructor(readonly db: D1Database) {}
  async getGiveaways(now = Date.now(), limit = 10): Promise<Offer[]> {
    const rows = await this.db
      .prepare(
        `SELECT offer_id AS id,game_id AS gameId,slug,title,shop,url,expires_at AS expiry
      FROM giveaways WHERE (expires_at IS NULL OR expires_at>?) ORDER BY discovered_at DESC,offer_id LIMIT ?`,
      )
      .bind(now, limit)
      .all<Offer>();
    return rows.results;
  }
  async ingestGiveaways(
    offers: Offer[],
    targets: string[],
    now: number,
    baseline: boolean,
  ): Promise<void> {
    if (!offers.length) return;
    const data = JSON.stringify(
      offers.map((x) => ({ ...x, text: formatGiveaway(x) })),
    );
    const chats = JSON.stringify([...new Set(targets.filter(Boolean))]);
    const statements: D1PreparedStatement[] = [];
    if (!baseline)
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO deliveries(id,kind,chat_id,text,due_at,expires_at,game_id)
      SELECT 'giveaway:'||json_extract(o.value,'$.id')||':'||c.value,'giveaway',c.value,
        json_extract(o.value,'$.text'),?,json_extract(o.value,'$.expiry'),json_extract(o.value,'$.gameId')
      FROM json_each(?) o CROSS JOIN json_each(?) c
      WHERE NOT EXISTS(SELECT 1 FROM giveaways WHERE offer_id=json_extract(o.value,'$.id'))
        AND NOT EXISTS(SELECT 1 FROM blocked_chats WHERE chat_id=c.value)`,
          )
          .bind(now, data, chats),
      );
    statements.push(
      this.db
        .prepare(
          `INSERT INTO giveaways(offer_id,game_id,slug,title,shop,url,expires_at,discovered_at,last_seen_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.gameId'),json_extract(value,'$.slug'),
        json_extract(value,'$.title'),json_extract(value,'$.shop'),json_extract(value,'$.url'),json_extract(value,'$.expiry'),?,?
      FROM json_each(?) WHERE 1 ON CONFLICT(offer_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,
        expires_at=excluded.expires_at,url=excluded.url`,
        )
        .bind(now, now, data),
    );
    await this.db.batch(statements);
  }
  async finishGiveawayScan(startedAt: number, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE giveaways SET expires_at=? WHERE last_seen_at<? AND (expires_at IS NULL OR expires_at>?)",
        )
        .bind(now, startedAt, now),
      this.db
        .prepare(
          "UPDATE deliveries SET status='expired' WHERE kind='giveaway' AND status='pending' AND EXISTS(SELECT 1 FROM giveaways g WHERE deliveries.id='giveaway:'||g.offer_id||':'||deliveries.chat_id AND g.expires_at<=?)",
        )
        .bind(now),
      this.db
        .prepare(
          "INSERT INTO settings(key,value,updated_at) VALUES('giveaways_seeded','true',?) ON CONFLICT(key) DO UPDATE SET value='true',updated_at=excluded.updated_at",
        )
        .bind(now),
      this.db
        .prepare(
          "INSERT INTO settings(key,value,updated_at) VALUES('last_giveaway_scan',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        )
        .bind(String(now), now),
    ]);
  }
}
