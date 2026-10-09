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

export class UpdatesRepository {
  constructor(readonly db: D1Database) {}
  async acceptUpdate(update: TelegramUpdate, now: number): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO telegram_updates(update_id,body,due_at,created_at) VALUES(?,?,?,?) ON CONFLICT(update_id) DO NOTHING",
      )
      .bind(update.update_id, JSON.stringify(update), now, now)
      .run();
  }
  async claimUpdate(
    id: number,
    now: number,
  ): Promise<{
    update: TelegramUpdate;
    token: string;
    createdAt: number;
    dueAt: number;
    attempts: number;
  } | null> {
    const row = await this.db
      .prepare(
        `UPDATE telegram_updates SET status='processing',lease_until=?,lease_token=?,attempts=attempts+1
      WHERE update_id=? AND due_at<=? AND (status='pending' OR (status='processing' AND lease_until<=?)) RETURNING body,lease_token,created_at,due_at,attempts`,
      )
      .bind(now + 120000, crypto.randomUUID(), id, now, now)
      .first<{
        body: string;
        lease_token: string;
        created_at: number;
        due_at: number;
        attempts: number;
      }>();
    return row
      ? {
          update: JSON.parse(row.body),
          token: row.lease_token,
          createdAt: row.created_at,
          dueAt: row.due_at,
          attempts: row.attempts,
        }
      : null;
  }
  async completeUpdate(id: number, token: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE telegram_updates SET status='done',lease_until=NULL WHERE update_id=? AND lease_token=? AND status='processing'",
      )
      .bind(id, token)
      .run();
  }
  async retryUpdate(id: number, token: string, dueAt: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE telegram_updates SET status='pending',lease_until=NULL,due_at=? WHERE update_id=? AND lease_token=? AND status='processing'",
      )
      .bind(dueAt, id, token)
      .run();
  }
  async pendingUpdates(now: number, limit = 10): Promise<number[]> {
    const rows = await this.db
      .prepare(
        "SELECT update_id FROM telegram_updates WHERE due_at<=? AND (status='pending' OR (status='processing' AND lease_until<=?)) ORDER BY due_at LIMIT ?",
      )
      .bind(now, now, limit)
      .all<{ update_id: number }>();
    return rows.results.map((x) => x.update_id);
  }
}
