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

const validPendingPrice = `EXISTS (SELECT 1 FROM wishlist w LEFT JOIN user_prefs p ON p.user_id=w.user_id
  WHERE w.user_id=deliveries.wishlist_user_id AND w.game_id=deliveries.game_id
  AND w.last_observed_price_cents=deliveries.price_cents
  AND COALESCE(w.last_notified_price_cents,w.baseline_price_cents)>0
  AND deliveries.price_cents*100 <= COALESCE(w.last_notified_price_cents,w.baseline_price_cents)
    *(100-MAX(10,COALESCE(w.min_discount_pct,p.min_discount_pct,10))))`;

export class DeliveriesRepository {
  constructor(readonly db: D1Database) {}
  async queueEdit(
    key: string,
    chatId: string,
    messageId: number,
    text: string,
    revision: number,
    replyMarkup?: unknown,
  ): Promise<string> {
    if (
      !Number.isSafeInteger(messageId) ||
      messageId <= 0 ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      throw new Error("Invalid edit target");
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO deliveries(id,kind,chat_id,text,reply_markup,due_at,expires_at,operation,telegram_message_id,view_revision)
      VALUES(?,'reply',?,?,?,?,?,'edit',?,?) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        key,
        chatId,
        text,
        replyMarkup == null ? null : JSON.stringify(replyMarkup),
        now,
        now + 86400000,
        messageId,
        revision,
      )
      .run();
    return key;
  }
  async isObsoleteEdit(delivery: Delivery): Promise<boolean> {
    if (delivery.operation !== "edit") return false;
    return Boolean(
      await this.db
        .prepare(
          `SELECT 1 FROM deliveries WHERE operation='edit' AND chat_id=?
      AND telegram_message_id=? AND view_revision>? LIMIT 1`,
        )
        .bind(
          delivery.chat_id,
          delivery.telegram_message_id,
          delivery.view_revision,
        )
        .first(),
    );
  }
  async pendingDeliveryJobs(
    now: number,
    limit = 20,
  ): Promise<Array<{ id: string; kind: Delivery["kind"] }>> {
    const rows = await this.db
      .prepare(
        `SELECT id,kind FROM deliveries WHERE due_at<=? AND
      (status='pending' OR (status='processing' AND lease_until<=?)) AND (expires_at IS NULL OR expires_at>?)
      ORDER BY due_at,id LIMIT ?`,
      )
      .bind(now, now, now, limit)
      .all<{ id: string; kind: Delivery["kind"] }>();
    return rows.results;
  }
  async queueMessage(
    key: string,
    chatId: string,
    text: string,
    replyMarkup?: unknown,
    expiresAt?: number | null,
  ): Promise<string> {
    await this.db
      .prepare(
        `INSERT INTO deliveries(id,kind,chat_id,text,reply_markup,due_at,expires_at)
      VALUES(?,'reply',?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        key,
        chatId,
        text,
        replyMarkup == null ? null : JSON.stringify(replyMarkup),
        Date.now(),
        expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
      )
      .run();
    return key;
  }
  async deliveryOffer(delivery: Delivery): Promise<Offer | null> {
    return this.db
      .prepare(
        `SELECT offer_id AS id,game_id AS gameId,slug,title,shop,url,expires_at AS expiry
      FROM giveaways WHERE ?='giveaway:'||offer_id||':'||?`,
      )
      .bind(delivery.id, delivery.chat_id)
      .first<Offer>();
  }
  async expireDelivery(delivery: Delivery): Promise<void> {
    await this.db
      .prepare(
        "UPDATE deliveries SET status='expired',lease_until=NULL WHERE id=? AND lease_token=? AND status='processing'",
      )
      .bind(delivery.id, delivery.lease_token)
      .run();
  }
  async cancelInvalidPending(now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE deliveries SET status='expired',lease_until=NULL WHERE
      (status='pending' OR (status='processing' AND lease_until<=?)) AND
      ((expires_at IS NOT NULL AND expires_at<=?) OR (kind='price' AND NOT ${validPendingPrice}))`,
      )
      .bind(now, now)
      .run();
  }
  async pendingDeliveries(now: number, limit = 20): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `SELECT id FROM deliveries WHERE due_at<=? AND
      (status='pending' OR (status='processing' AND lease_until<=?)) AND (expires_at IS NULL OR expires_at>?)
      ORDER BY due_at,id LIMIT ?`,
      )
      .bind(now, now, now, limit)
      .all<{ id: string }>();
    return rows.results.map((x) => x.id);
  }
  async pendingEditDelay(id: string, now: number): Promise<number | null> {
    const row = await this.db
      .prepare(
        "SELECT due_at FROM deliveries WHERE id=? AND operation='edit' AND status='pending' AND (expires_at IS NULL OR expires_at>?)",
      )
      .bind(id, now)
      .first<{ due_at: number }>();
    return row ? Math.max(2, Math.ceil((row.due_at - now) / 1000)) : null;
  }
  async claimDelivery(id: string, now: number): Promise<Delivery | null> {
    return this.db
      .prepare(
        `UPDATE deliveries SET status='processing',lease_until=?,lease_token=?,attempts=attempts+1
      WHERE id=? AND due_at<=? AND (status='pending' OR (status='processing' AND lease_until<=?))
        AND (expires_at IS NULL OR expires_at>?) AND (kind!='price' OR ${validPendingPrice})
        AND (operation!='edit' OR NOT EXISTS (SELECT 1 FROM deliveries active
          WHERE active.operation='edit' AND active.status='processing' AND active.lease_until>?
          AND active.chat_id=deliveries.chat_id AND active.telegram_message_id=deliveries.telegram_message_id
          AND active.id!=deliveries.id)) RETURNING *`,
      )
      .bind(now + 120000, crypto.randomUUID(), id, now, now, now, now)
      .first<Delivery>();
  }
  async completeDelivery(delivery: Delivery, now: number): Promise<void> {
    const statements = [
      this.db
        .prepare(
          `UPDATE deliveries SET status='sent',sent_at=?,lease_until=NULL,error_code=NULL
      WHERE id=? AND status='processing' AND lease_token=?`,
        )
        .bind(now, delivery.id, delivery.lease_token),
    ];
    if (delivery.kind === "price")
      statements.push(
        this.db
          .prepare(
            `UPDATE wishlist SET
      last_notified_price_cents=CASE WHEN last_notified_price_cents IS NULL THEN ? ELSE MIN(last_notified_price_cents,?) END,
      last_notified_at=? WHERE user_id=? AND game_id=? AND EXISTS(SELECT 1 FROM deliveries
        WHERE id=? AND status='sent' AND lease_token=? AND sent_at=?)`,
          )
          .bind(
            delivery.price_cents,
            delivery.price_cents,
            now,
            delivery.wishlist_user_id,
            delivery.game_id,
            delivery.id,
            delivery.lease_token,
            now,
          ),
      );
    await this.db.batch(statements);
  }
  async retryDelivery(
    delivery: Delivery,
    dueAt: number,
    code: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE deliveries SET status='pending',due_at=?,lease_until=NULL,error_code=? WHERE id=? AND status='processing' AND lease_token=?",
      )
      .bind(dueAt, code, delivery.id, delivery.lease_token)
      .run();
  }
  async blockDelivery(
    delivery: Delivery,
    code: string,
    blockChat: boolean,
    now: number,
  ): Promise<void> {
    const statements = [
      this.db
        .prepare(
          "UPDATE deliveries SET status='blocked',lease_until=NULL,error_code=? WHERE id=? AND lease_token=?",
        )
        .bind(code, delivery.id, delivery.lease_token),
    ];
    if (blockChat) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO blocked_chats(chat_id,blocked_at) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET blocked_at=excluded.blocked_at",
          )
          .bind(delivery.chat_id, now),
      );
      statements.push(
        this.db
          .prepare(
            "UPDATE deliveries SET status='blocked',error_code=? WHERE chat_id=? AND status='pending'",
          )
          .bind(code, delivery.chat_id),
      );
    }
    await this.db.batch(statements);
  }
  async unblockChat(chatId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM blocked_chats WHERE chat_id=?")
      .bind(chatId)
      .run();
  }
}
