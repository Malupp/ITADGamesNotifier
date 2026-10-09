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

export class SettingsRepository {
  constructor(readonly db: D1Database) {}
  async getSetting(key: string): Promise<string | null> {
    return this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .bind(key)
      .first<string>("value");
  }
  async setSetting(
    key: string,
    value: string,
    now = Date.now(),
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      )
      .bind(key, value, now)
      .run();
  }
  async status(): Promise<{
    lastGiveawayScan: number | null;
    lastPriceScan: number | null;
    queued: number;
    blocked: number;
  }> {
    const rows = await this.db
      .prepare(
        "SELECT key,value FROM settings WHERE key IN ('last_giveaway_scan','last_price_scan')",
      )
      .all<{ key: string; value: string }>();
    const values = new Map(rows.results.map((x) => [x.key, Number(x.value)]));
    const counts = await this.db
      .prepare(
        "SELECT SUM(status IN ('pending','processing')) AS queued,SUM(status='blocked') AS blocked FROM deliveries",
      )
      .first<{ queued: number; blocked: number }>();
    return {
      lastGiveawayScan: values.get("last_giveaway_scan") ?? null,
      lastPriceScan: values.get("last_price_scan") ?? null,
      queued: counts?.queued ?? 0,
      blocked: counts?.blocked ?? 0,
    };
  }
}
