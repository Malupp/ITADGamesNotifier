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

export class WishlistRepository {
  constructor(readonly db: D1Database) {}
  async getWishlist(userId: string): Promise<WishlistItem[]> {
    return (
      await this.db
        .prepare(
          "SELECT * FROM wishlist WHERE user_id=? ORDER BY added_at DESC,game_id",
        )
        .bind(userId)
        .all<WishlistItem>()
    ).results;
  }
  async addWishlist(
    userId: string,
    username: string | null,
    game: Game,
    quote: PriceQuote | null,
    now = Date.now(),
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO wishlist(user_id,game_id,title,username,price_at_add_cents,
      baseline_price_cents,last_observed_price_cents,last_shop,last_url,added_at,last_observed_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM wishlist WHERE game_id=?) OR
        (SELECT COUNT(DISTINCT game_id) FROM wishlist)<200 ON CONFLICT(user_id,game_id) DO NOTHING`,
      )
      .bind(
        userId,
        game.id,
        game.title,
        username,
        quote?.priceCents ?? null,
        quote?.priceCents ?? null,
        quote?.priceCents ?? null,
        quote?.shop ?? null,
        quote?.url ?? null,
        now,
        quote ? now : null,
        game.id,
      )
      .run();
    return result.meta.changes > 0;
  }
  async removeWishlist(userId: string, gameId: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare("DELETE FROM wishlist WHERE user_id=? AND game_id=?")
        .bind(userId, gameId),
      this.db
        .prepare(
          "UPDATE deliveries SET status='expired' WHERE kind='price' AND wishlist_user_id=? AND game_id=? AND status='pending'",
        )
        .bind(userId, gameId),
    ]);
    return results[0].meta.changes > 0;
  }
  async setWishlistDiscount(
    userId: string,
    gameId: string,
    pct: number | null,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE wishlist SET min_discount_pct=? WHERE user_id=? AND game_id=?",
      )
      .bind(pct === null ? null : effectiveThreshold(pct), userId, gameId)
      .run();
    return result.meta.changes > 0;
  }
  async gameIds(): Promise<string[]> {
    const rows = await this.db
      .prepare("SELECT DISTINCT game_id FROM wishlist ORDER BY game_id")
      .all<{ game_id: string }>();
    return rows.results.map((x) => x.game_id);
  }
  async ingestPrices(
    quotes: PriceQuote[],
    now: number,
    quiet = false,
  ): Promise<void> {
    if (!quotes.length) return;
    const data = JSON.stringify(
      quotes.map((q) => ({
        ...q,
        sale:
          q.currency === "EUR" &&
          q.cut > 0 &&
          q.regularCents !== null &&
          q.regularCents > q.priceCents,
        expiry: Math.min(q.expiry ?? Infinity, now + 30 * 60 * 1000),
        suffix: `</b>\n🏪 ${escapeHtml(q.shop)}\n💰 <b>${money(q.priceCents)}</b>\n🔗 <a href="${escapeHtml(q.url)}">Vedi l'offerta</a>`,
      })),
    );
    await this.db.batch([
      ...(quiet
        ? [
            this.db
              .prepare(
                `UPDATE wishlist SET baseline_price_cents=json_extract(q.value,'$.priceCents'),baseline_origin='initial'
        FROM json_each(?) q WHERE wishlist.game_id=json_extract(q.value,'$.gameId') AND last_notified_price_cents IS NULL`,
              )
              .bind(data),
          ]
        : []),
      this.db
        .prepare(
          `UPDATE deliveries SET status='expired' WHERE kind='price' AND status='pending'
        AND EXISTS(SELECT 1 FROM json_each(?) q WHERE json_extract(q.value,'$.gameId')=deliveries.game_id
          AND (json_extract(q.value,'$.priceCents')!=deliveries.price_cents OR NOT json_extract(q.value,'$.sale')))`,
        )
        .bind(data),
      this.db
        .prepare(
          `INSERT INTO deliveries(id,kind,chat_id,text,due_at,expires_at,wishlist_user_id,game_id,price_cents)
        SELECT 'price:'||w.user_id||':'||w.game_id||':'||w.added_at||':'||COALESCE(w.last_notified_price_cents,w.baseline_price_cents)||':'||json_extract(q.value,'$.priceCents'),'price',w.user_id,
          '🔔 <b>Ribasso wishlist</b>\n🎮 <b>'||replace(replace(replace(w.title,'&','&amp;'),'<','&lt;'),'>','&gt;')||json_extract(q.value,'$.suffix'),
          ?,json_extract(q.value,'$.expiry'),w.user_id,w.game_id,json_extract(q.value,'$.priceCents')
        FROM wishlist w JOIN json_each(?) q ON w.game_id=json_extract(q.value,'$.gameId')
        LEFT JOIN user_prefs p ON p.user_id=w.user_id
        WHERE json_extract(q.value,'$.sale') AND ? AND COALESCE(w.last_notified_price_cents,w.baseline_price_cents)>0
          AND json_extract(q.value,'$.priceCents')*100 <= COALESCE(w.last_notified_price_cents,w.baseline_price_cents)
            *(100-MAX(10,COALESCE(w.min_discount_pct,p.min_discount_pct,10)))
          AND NOT EXISTS(SELECT 1 FROM blocked_chats WHERE chat_id=w.user_id)
          AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.kind='price' AND d.wishlist_user_id=w.user_id AND d.game_id=w.game_id AND d.status IN ('pending','processing'))
        ON CONFLICT(id) DO UPDATE SET status='pending',due_at=excluded.due_at,expires_at=excluded.expires_at,
          text=excluded.text,lease_until=NULL,lease_token=NULL,attempts=0,error_code=NULL WHERE deliveries.status='expired'`,
        )
        .bind(now, data, Number(!quiet)),
      this.db
        .prepare(
          `UPDATE wishlist SET last_observed_price_cents=json_extract(q.value,'$.priceCents'),
        baseline_price_cents=COALESCE(baseline_price_cents,json_extract(q.value,'$.priceCents')),
        last_shop=json_extract(q.value,'$.shop'),last_url=json_extract(q.value,'$.url'),last_observed_at=?
        FROM json_each(?) q WHERE wishlist.game_id=json_extract(q.value,'$.gameId')`,
        )
        .bind(now, data),
    ]);
  }
  async invalidateMissingPrices(gameIds: string[], now: number): Promise<void> {
    if (!gameIds.length) return;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE wishlist SET last_observed_price_cents=NULL,last_observed_at=? WHERE game_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(now, JSON.stringify(gameIds)),
      this.db
        .prepare(
          `UPDATE deliveries SET status='expired' WHERE kind='price' AND status='pending' AND game_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify(gameIds)),
    ]);
  }
}
