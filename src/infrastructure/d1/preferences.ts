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

export class PreferencesRepository {
  constructor(readonly db: D1Database) {}
  async getPrefs(userId: string): Promise<Preferences> {
    const row = await this.db
      .prepare("SELECT * FROM user_prefs WHERE user_id=?")
      .bind(userId)
      .first<any>();
    return {
      thresholdCents: row?.threshold_cents ?? 500,
      minCut: row?.min_cut ?? 0,
      minScore: row?.min_score ?? 0,
      minDiscountPct: effectiveThreshold(row?.min_discount_pct),
    };
  }
  async setPrefs(
    userId: string,
    username: string | null,
    patch: Partial<Preferences>,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_prefs(user_id,username,threshold_cents,min_cut,min_score,min_discount_pct)
      VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,
      threshold_cents=COALESCE(?,user_prefs.threshold_cents),min_cut=COALESCE(?,user_prefs.min_cut),
      min_score=COALESCE(?,user_prefs.min_score),min_discount_pct=COALESCE(?,user_prefs.min_discount_pct)`,
      )
      .bind(
        userId,
        username,
        patch.thresholdCents ?? 500,
        patch.minCut ?? 0,
        patch.minScore ?? 0,
        effectiveThreshold(patch.minDiscountPct),
        patch.thresholdCents ?? null,
        patch.minCut ?? null,
        patch.minScore ?? null,
        patch.minDiscountPct == null
          ? null
          : effectiveThreshold(patch.minDiscountPct),
      )
      .run();
  }
  async registerPrivateUser(userId: string, receivedAt: number): Promise<boolean> {
    if (!/^[1-9]\d*$/.test(userId) || !Number.isSafeInteger(Number(userId))) return false;
    // Unblocking and invalidating in-flight failures must have no await gap.
    const result = await this.db.batch([
      this.db.prepare(`UPDATE news_subscribers SET enabled=0,generation=generation+1,revision=revision+1,updated_at=?
        WHERE chat_id=? AND enabled=1 AND EXISTS(SELECT 1 FROM blocked_chats WHERE chat_id=? AND blocked_at<=?)`)
        .bind(receivedAt, userId, userId, receivedAt),
      this.db.prepare("DELETE FROM blocked_chats WHERE chat_id=? AND blocked_at<=?")
        .bind(userId, receivedAt),
      this.db.prepare(`INSERT INTO private_users(user_id,started_at,last_seen_at,activity_revision)
        SELECT ?,?,?,1 WHERE NOT EXISTS(SELECT 1 FROM blocked_chats WHERE chat_id=?)
        ON CONFLICT(user_id) DO UPDATE SET last_seen_at=MAX(last_seen_at,excluded.last_seen_at),activity_revision=activity_revision+1`)
        .bind(userId, receivedAt, receivedAt, userId),
    ]);
    return result[2].meta.changes === 1;
  }
  async privateActivity(userId: string): Promise<number | null> {
    const row = await this.db.prepare("SELECT activity_revision FROM private_users WHERE user_id=?")
      .bind(userId).first<{ activity_revision: number }>();
    return row?.activity_revision ?? null;
  }
  async isAvailable(userId: string): Promise<boolean> {
    return Boolean(await this.db.prepare("SELECT 1 FROM private_users WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM blocked_chats WHERE chat_id=user_id)").bind(userId).first());
  }
  async notifications(userId: string) {
    return await this.db.prepare("SELECT recent_deals_enabled AS enabled,recent_deals_revision AS revision,recent_deals_generation AS generation FROM private_users WHERE user_id=?").bind(userId).first<{enabled:number;revision:number;generation:number}>() ?? {enabled:0,revision:0,generation:0};
  }
  async recentDealTargets(): Promise<string[]> {
    return (await this.db.prepare("SELECT user_id FROM private_users WHERE recent_deals_enabled=1 AND NOT EXISTS(SELECT 1 FROM blocked_chats WHERE chat_id=user_id) ORDER BY user_id").all<{user_id:string}>()).results.map(x=>x.user_id);
  }
  async canNotifyRecent(userId: string, generation: number | null) {
    return Boolean(await this.db.prepare("SELECT 1 FROM private_users WHERE user_id=? AND recent_deals_enabled=1 AND recent_deals_generation=? AND NOT EXISTS(SELECT 1 FROM blocked_chats WHERE chat_id=user_id)").bind(userId,generation).first());
  }
  async setRecentDeals(userId: string,on: boolean,now: number,updateId: number,receivedAt=now,expected?: number): Promise<boolean> {
    const row=await this.db.prepare(`UPDATE private_users SET recent_deals_enabled=?,recent_deals_revision=recent_deals_revision+1,
      recent_deals_generation=recent_deals_generation+CASE WHEN recent_deals_enabled!=? THEN 1 ELSE 0 END,recent_deals_update_id=?,recent_deals_received_at=?
      WHERE user_id=? AND ? >= recent_deals_received_at AND ? >= ?
      AND (recent_deals_update_id<? OR ?>recent_deals_received_at+604800000)
      AND (? IS NULL OR recent_deals_revision=?) RETURNING recent_deals_generation AS generation`)
      .bind(Number(on),Number(on),updateId,receivedAt,userId,receivedAt,receivedAt,now-86400000,updateId,receivedAt,expected??null,expected??null).first<{generation:number}>();
    if (!row) return false;
    if (!on) await this.db.prepare("UPDATE deliveries SET status='expired',lease_token=NULL,lease_until=NULL WHERE source='keydeal' AND chat_id=? AND price_generation<=? AND status IN ('pending','processing')").bind(userId,row.generation).run();
    return true;
  }
}
