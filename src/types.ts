export interface Env {
  DB: D1Database;
  WORK_QUEUE: Queue<QueueJob>;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ITAD_API_KEY: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_CHAT_GROUP?: string;
  GGDEALS_API_KEY?: string;
  SCANS_ENABLED?: string;
}

export type QueueJob =
  | { kind: 'tick'; part: 'prices'|'giveaways'|'recover'; scheduledAt: number; initialize: boolean }
  | { kind: 'probe'; scenario: 'deals'|'prices' }
  | { kind: 'scan'; id: string }
  | { kind: 'delivery'; id: string }
  | { kind: 'update'; id: number };

export interface Game { id: string; slug: string; title: string; type: string }
export interface PriceQuote {
  gameId: string; shop: string; shopId: number; url: string;
  priceCents: number; regularCents: number | null; cut: number;
  currency: string; expiry: number | null;
}
export interface Offer {
  id: string; gameId: string; slug: string; title: string;
  shop: string; url: string; expiry: number | null;
}
export interface Preferences {
  thresholdCents: number; minCut: number; minScore: number; minDiscountPct: number;
}
export interface WishlistItem {
  user_id: string; game_id: string; title: string; username: string | null;
  price_at_add_cents: number | null; baseline_price_cents: number | null;
  last_observed_price_cents: number | null; last_notified_price_cents: number | null;
  min_discount_pct: number | null; last_shop: string | null; last_url: string | null;
  added_at: number; last_observed_at: number | null; last_notified_at: number | null;
}
export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; text?: string; chat: { id: number; type?: string }; from?: { id: number; username?: string; first_name?: string } };
  callback_query?: { id: string; data?: string; from: { id: number; username?: string; first_name?: string }; message?: { message_id: number; chat: { id: number } } };
}
export interface Delivery {
  id: string; kind: 'reply' | 'giveaway' | 'price'; chat_id: string; text: string;
  reply_markup: string | null; status: string; attempts: number; due_at: number;
  lease_until: number | null; lease_token: string | null; expires_at: number | null;
  wishlist_user_id: string | null; game_id: string | null; price_cents: number | null;
}
