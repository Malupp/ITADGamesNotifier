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
}
