export interface ResultView {
  userId: string;
  chatId: string;
  expiresAt: number;
  pages: Array<{ text: string; replyMarkup?: unknown }>;
  backId?: string;
}

/** Short-lived UI snapshots share settings storage; runtime state remains separate. */
export class ViewsRepository {
  constructor(readonly db: D1Database) {}
  async save(id: string, view: ResultView, now: number): Promise<void> {
    await this.db.prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING",
    ).bind(`telegram_view:${id}`, JSON.stringify(view), now).run();
  }
  async get(id: string): Promise<ResultView | null> {
    if (!/^\d{1,16}$/.test(id)) return null;
    const raw = await this.db.prepare("SELECT value FROM settings WHERE key=?")
      .bind(`telegram_view:${id}`).first<string>("value");
    return raw ? JSON.parse(raw) as ResultView : null;
  }
  async prune(now: number): Promise<void> {
    await this.db.prepare(
      "DELETE FROM settings WHERE key IN (SELECT key FROM settings WHERE key GLOB 'telegram_view:*' AND updated_at<? LIMIT 100)",
    ).bind(now - 86400000).run();
  }
}
