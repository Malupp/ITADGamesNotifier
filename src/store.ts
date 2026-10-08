import type { Delivery, Game, Offer, Preferences, PriceQuote, TelegramUpdate, WishlistItem } from './types.ts';
import { effectiveThreshold, escapeHtml, formatGiveaway, money } from './domain.ts';

const validPendingPrice = `EXISTS (SELECT 1 FROM wishlist w LEFT JOIN user_prefs p ON p.user_id=w.user_id
  WHERE w.user_id=deliveries.wishlist_user_id AND w.game_id=deliveries.game_id
  AND w.last_observed_price_cents=deliveries.price_cents
  AND COALESCE(w.last_notified_price_cents,w.baseline_price_cents)>0
  AND deliveries.price_cents*100 <= COALESCE(w.last_notified_price_cents,w.baseline_price_cents)
    *(100-MAX(10,COALESCE(w.min_discount_pct,p.min_discount_pct,10))))`;

export class Store {
  constructor(readonly db: D1Database) {}
  async getSetting(key: string): Promise<string | null> {
    return this.db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first<string>('value');
  }
  async setSetting(key: string, value: string, now = Date.now()): Promise<void> {
    await this.db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .bind(key, value, now).run();
  }
  async getPrefs(userId: string): Promise<Preferences> {
    const row = await this.db.prepare('SELECT * FROM user_prefs WHERE user_id=?').bind(userId).first<any>();
    return { thresholdCents: row?.threshold_cents ?? 500, minCut: row?.min_cut ?? 0,
      minScore: row?.min_score ?? 0, minDiscountPct: effectiveThreshold(row?.min_discount_pct) };
  }
  async setPrefs(userId: string, username: string | null, patch: Partial<Preferences>): Promise<void> {
    await this.db.prepare(`INSERT INTO user_prefs(user_id,username,threshold_cents,min_cut,min_score,min_discount_pct)
      VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,
      threshold_cents=COALESCE(?,user_prefs.threshold_cents),min_cut=COALESCE(?,user_prefs.min_cut),
      min_score=COALESCE(?,user_prefs.min_score),min_discount_pct=COALESCE(?,user_prefs.min_discount_pct)`)
      .bind(userId, username, patch.thresholdCents ?? 500, patch.minCut ?? 0, patch.minScore ?? 0,
        effectiveThreshold(patch.minDiscountPct), patch.thresholdCents ?? null, patch.minCut ?? null,
        patch.minScore ?? null, patch.minDiscountPct == null ? null : effectiveThreshold(patch.minDiscountPct)).run();
  }
  async getWishlist(userId: string): Promise<WishlistItem[]> {
    return (await this.db.prepare('SELECT * FROM wishlist WHERE user_id=? ORDER BY added_at DESC,game_id').bind(userId).all<WishlistItem>()).results;
  }
  async addWishlist(userId: string, username: string | null, game: Game, quote: PriceQuote | null, now = Date.now()): Promise<boolean> {
    const result = await this.db.prepare(`INSERT INTO wishlist(user_id,game_id,title,username,price_at_add_cents,
      baseline_price_cents,last_observed_price_cents,last_shop,last_url,added_at,last_observed_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM wishlist WHERE game_id=?) OR
        (SELECT COUNT(DISTINCT game_id) FROM wishlist)<200 ON CONFLICT(user_id,game_id) DO NOTHING`)
      .bind(userId, game.id, game.title, username, quote?.priceCents ?? null, quote?.priceCents ?? null,
        quote?.priceCents ?? null, quote?.shop ?? null, quote?.url ?? null, now, quote ? now : null,game.id).run();
    return result.meta.changes > 0;
  }
  async removeWishlist(userId: string, gameId: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare('DELETE FROM wishlist WHERE user_id=? AND game_id=?').bind(userId, gameId),
      this.db.prepare("UPDATE deliveries SET status='expired' WHERE kind='price' AND wishlist_user_id=? AND game_id=? AND status='pending'").bind(userId, gameId),
    ]);
    return results[0].meta.changes > 0;
  }
  async setWishlistDiscount(userId: string, gameId: string, pct: number | null): Promise<boolean> {
    const result = await this.db.prepare('UPDATE wishlist SET min_discount_pct=? WHERE user_id=? AND game_id=?')
      .bind(pct === null ? null : effectiveThreshold(pct), userId, gameId).run();
    return result.meta.changes > 0;
  }
  async gameIds(): Promise<string[]> {
    const rows = await this.db.prepare('SELECT DISTINCT game_id FROM wishlist ORDER BY game_id').all<{game_id:string}>();
    return rows.results.map(x => x.game_id);
  }
  async getGiveaways(now = Date.now(), limit = 10): Promise<Offer[]> {
    const rows = await this.db.prepare(`SELECT offer_id AS id,game_id AS gameId,slug,title,shop,url,expires_at AS expiry
      FROM giveaways WHERE (expires_at IS NULL OR expires_at>?) ORDER BY discovered_at DESC,offer_id LIMIT ?`).bind(now,limit).all<Offer>();
    return rows.results;
  }
  async ingestGiveaways(offers: Offer[], targets: string[], now: number, baseline: boolean): Promise<void> {
    if (!offers.length) return;
    const data = JSON.stringify(offers.map(x => ({ ...x, text: formatGiveaway(x) })));
    const chats = JSON.stringify([...new Set(targets.filter(Boolean))]);
    const statements: D1PreparedStatement[] = [];
    if (!baseline) statements.push(this.db.prepare(`INSERT OR IGNORE INTO deliveries(id,kind,chat_id,text,due_at,expires_at,game_id)
      SELECT 'giveaway:'||json_extract(o.value,'$.id')||':'||c.value,'giveaway',c.value,
        json_extract(o.value,'$.text'),?,json_extract(o.value,'$.expiry'),json_extract(o.value,'$.gameId')
      FROM json_each(?) o CROSS JOIN json_each(?) c
      WHERE NOT EXISTS(SELECT 1 FROM giveaways WHERE offer_id=json_extract(o.value,'$.id'))
        AND NOT EXISTS(SELECT 1 FROM blocked_chats WHERE chat_id=c.value)`).bind(now,data,chats));
    statements.push(this.db.prepare(`INSERT INTO giveaways(offer_id,game_id,slug,title,shop,url,expires_at,discovered_at,last_seen_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.gameId'),json_extract(value,'$.slug'),
        json_extract(value,'$.title'),json_extract(value,'$.shop'),json_extract(value,'$.url'),json_extract(value,'$.expiry'),?,?
      FROM json_each(?) WHERE 1 ON CONFLICT(offer_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,
        expires_at=excluded.expires_at,url=excluded.url`).bind(now,now,data));
    await this.db.batch(statements);
  }
  async finishGiveawayScan(startedAt: number, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE giveaways SET expires_at=? WHERE last_seen_at<? AND (expires_at IS NULL OR expires_at>?)").bind(now,startedAt,now),
      this.db.prepare("UPDATE deliveries SET status='expired' WHERE kind='giveaway' AND status='pending' AND EXISTS(SELECT 1 FROM giveaways g WHERE deliveries.id='giveaway:'||g.offer_id||':'||deliveries.chat_id AND g.expires_at<=?)").bind(now),
      this.db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('giveaways_seeded','true',?) ON CONFLICT(key) DO UPDATE SET value='true',updated_at=excluded.updated_at").bind(now),
      this.db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('last_giveaway_scan',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(String(now),now),
    ]);
  }
  async ingestPrices(quotes: PriceQuote[], now: number, quiet = false): Promise<void> {
    if (!quotes.length) return;
    const data = JSON.stringify(quotes.map(q => ({ ...q,
      sale: q.currency === 'EUR' && q.cut > 0 && q.regularCents !== null && q.regularCents > q.priceCents,
      expiry: Math.min(q.expiry ?? Infinity,now+30*60*1000),
      suffix: `</b>\n🏪 ${escapeHtml(q.shop)}\n💰 <b>${money(q.priceCents)}</b>\n🔗 <a href="${escapeHtml(q.url)}">Vedi l'offerta</a>` })));
    await this.db.batch([
      ...(quiet ? [this.db.prepare(`UPDATE wishlist SET baseline_price_cents=json_extract(q.value,'$.priceCents'),baseline_origin='initial'
        FROM json_each(?) q WHERE wishlist.game_id=json_extract(q.value,'$.gameId') AND last_notified_price_cents IS NULL`).bind(data)] : []),
      this.db.prepare(`UPDATE deliveries SET status='expired' WHERE kind='price' AND status='pending'
        AND EXISTS(SELECT 1 FROM json_each(?) q WHERE json_extract(q.value,'$.gameId')=deliveries.game_id
          AND (json_extract(q.value,'$.priceCents')!=deliveries.price_cents OR NOT json_extract(q.value,'$.sale')))`)
        .bind(data),
      this.db.prepare(`INSERT INTO deliveries(id,kind,chat_id,text,due_at,expires_at,wishlist_user_id,game_id,price_cents)
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
          text=excluded.text,lease_until=NULL,lease_token=NULL,attempts=0,error_code=NULL WHERE deliveries.status='expired'`)
        .bind(now,data,Number(!quiet)),
      this.db.prepare(`UPDATE wishlist SET last_observed_price_cents=json_extract(q.value,'$.priceCents'),
        baseline_price_cents=COALESCE(baseline_price_cents,json_extract(q.value,'$.priceCents')),
        last_shop=json_extract(q.value,'$.shop'),last_url=json_extract(q.value,'$.url'),last_observed_at=?
        FROM json_each(?) q WHERE wishlist.game_id=json_extract(q.value,'$.gameId')`).bind(now,data),
    ]);
  }
  async queueMessage(key: string, chatId: string, text: string, replyMarkup?: unknown, expiresAt?: number | null): Promise<string> {
    await this.db.prepare(`INSERT INTO deliveries(id,kind,chat_id,text,reply_markup,due_at,expires_at)
      VALUES(?,'reply',?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(key,chatId,text,replyMarkup == null ? null : JSON.stringify(replyMarkup),Date.now(),expiresAt ?? Date.now()+24*60*60*1000).run();
    return key;
  }
  async invalidateMissingPrices(gameIds: string[], now:number):Promise<void>{
    if(!gameIds.length)return;
    await this.db.batch([
      this.db.prepare(`UPDATE wishlist SET last_observed_price_cents=NULL,last_observed_at=? WHERE game_id IN (SELECT value FROM json_each(?))`).bind(now,JSON.stringify(gameIds)),
      this.db.prepare(`UPDATE deliveries SET status='expired' WHERE kind='price' AND status='pending' AND game_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(gameIds)),
    ]);
  }
  async deliveryOffer(delivery:Delivery):Promise<Offer|null>{
    return this.db.prepare(`SELECT offer_id AS id,game_id AS gameId,slug,title,shop,url,expires_at AS expiry
      FROM giveaways WHERE ?='giveaway:'||offer_id||':'||?`).bind(delivery.id,delivery.chat_id).first<Offer>();
  }
  async expireDelivery(delivery:Delivery):Promise<void>{
    await this.db.prepare("UPDATE deliveries SET status='expired',lease_until=NULL WHERE id=? AND lease_token=? AND status='processing'").bind(delivery.id,delivery.lease_token).run();
  }
  async cancelInvalidPending(now: number): Promise<void> {
    await this.db.prepare(`UPDATE deliveries SET status='expired',lease_until=NULL WHERE
      (status='pending' OR (status='processing' AND lease_until<=?)) AND
      ((expires_at IS NOT NULL AND expires_at<=?) OR (kind='price' AND NOT ${validPendingPrice}))`).bind(now,now).run();
  }
  async pendingDeliveries(now: number, limit = 20): Promise<string[]> {
    const rows = await this.db.prepare(`SELECT id FROM deliveries WHERE due_at<=? AND
      (status='pending' OR (status='processing' AND lease_until<=?)) AND (expires_at IS NULL OR expires_at>?)
      ORDER BY due_at,id LIMIT ?`).bind(now,now,now,limit).all<{id:string}>();
    return rows.results.map(x=>x.id);
  }
  async claimDelivery(id: string, now: number): Promise<Delivery | null> {
    return this.db.prepare(`UPDATE deliveries SET status='processing',lease_until=?,lease_token=?,attempts=attempts+1
      WHERE id=? AND due_at<=? AND (status='pending' OR (status='processing' AND lease_until<=?))
        AND (expires_at IS NULL OR expires_at>?) AND (kind!='price' OR ${validPendingPrice}) RETURNING *`)
      .bind(now+120000,crypto.randomUUID(),id,now,now,now).first<Delivery>();
  }
  async completeDelivery(delivery: Delivery, now: number): Promise<void> {
    const statements = [this.db.prepare(`UPDATE deliveries SET status='sent',sent_at=?,lease_until=NULL,error_code=NULL
      WHERE id=? AND status='processing' AND lease_token=?`).bind(now,delivery.id,delivery.lease_token)];
    if (delivery.kind==='price') statements.push(this.db.prepare(`UPDATE wishlist SET
      last_notified_price_cents=CASE WHEN last_notified_price_cents IS NULL THEN ? ELSE MIN(last_notified_price_cents,?) END,
      last_notified_at=? WHERE user_id=? AND game_id=? AND EXISTS(SELECT 1 FROM deliveries
        WHERE id=? AND status='sent' AND lease_token=? AND sent_at=?)`)
      .bind(delivery.price_cents,delivery.price_cents,now,delivery.wishlist_user_id,delivery.game_id,delivery.id,delivery.lease_token,now));
    await this.db.batch(statements);
  }
  async retryDelivery(delivery: Delivery, dueAt: number, code: string): Promise<void> {
    await this.db.prepare("UPDATE deliveries SET status='pending',due_at=?,lease_until=NULL,error_code=? WHERE id=? AND status='processing' AND lease_token=?")
      .bind(dueAt,code,delivery.id,delivery.lease_token).run();
  }
  async blockDelivery(delivery: Delivery, code: string, blockChat: boolean, now: number): Promise<void> {
    const statements = [this.db.prepare("UPDATE deliveries SET status='blocked',lease_until=NULL,error_code=? WHERE id=? AND lease_token=?")
      .bind(code,delivery.id,delivery.lease_token)];
    if (blockChat) {
      statements.push(this.db.prepare('INSERT INTO blocked_chats(chat_id,blocked_at) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET blocked_at=excluded.blocked_at').bind(delivery.chat_id,now));
      statements.push(this.db.prepare("UPDATE deliveries SET status='blocked',error_code=? WHERE chat_id=? AND status='pending'").bind(code,delivery.chat_id));
    }
    await this.db.batch(statements);
  }
  async acceptUpdate(update: TelegramUpdate, now: number): Promise<void> {
    await this.db.prepare('INSERT INTO telegram_updates(update_id,body,due_at,created_at) VALUES(?,?,?,?) ON CONFLICT(update_id) DO NOTHING')
      .bind(update.update_id,JSON.stringify(update),now,now).run();
  }
  async claimUpdate(id: number, now: number): Promise<{update:TelegramUpdate;token:string} | null> {
    const row = await this.db.prepare(`UPDATE telegram_updates SET status='processing',lease_until=?,lease_token=?,attempts=attempts+1
      WHERE update_id=? AND due_at<=? AND (status='pending' OR (status='processing' AND lease_until<=?)) RETURNING body,lease_token`)
      .bind(now+120000,crypto.randomUUID(),id,now,now).first<{body:string;lease_token:string}>();
    return row ? {update:JSON.parse(row.body),token:row.lease_token} : null;
  }
  async completeUpdate(id: number, token: string): Promise<void> {
    await this.db.prepare("UPDATE telegram_updates SET status='done',lease_until=NULL WHERE update_id=? AND lease_token=? AND status='processing'").bind(id,token).run();
  }
  async retryUpdate(id: number, token: string, dueAt: number): Promise<void> {
    await this.db.prepare("UPDATE telegram_updates SET status='pending',lease_until=NULL,due_at=? WHERE update_id=? AND lease_token=? AND status='processing'").bind(dueAt,id,token).run();
  }
  async pendingUpdates(now: number, limit=10): Promise<number[]> {
    const rows = await this.db.prepare("SELECT update_id FROM telegram_updates WHERE due_at<=? AND (status='pending' OR (status='processing' AND lease_until<=?)) ORDER BY due_at LIMIT ?").bind(now,now,limit).all<{update_id:number}>();
    return rows.results.map(x=>x.update_id);
  }
  async unblockChat(chatId: string): Promise<void> { await this.db.prepare('DELETE FROM blocked_chats WHERE chat_id=?').bind(chatId).run(); }
  async status(): Promise<{lastGiveawayScan:number|null;lastPriceScan:number|null;queued:number;blocked:number}> {
    const rows = await this.db.prepare("SELECT key,value FROM settings WHERE key IN ('last_giveaway_scan','last_price_scan')").all<{key:string;value:string}>();
    const values = new Map(rows.results.map(x=>[x.key,Number(x.value)]));
    const counts = await this.db.prepare("SELECT SUM(status IN ('pending','processing')) AS queued,SUM(status='blocked') AS blocked FROM deliveries").first<{queued:number;blocked:number}>();
    return { lastGiveawayScan:values.get('last_giveaway_scan')??null,lastPriceScan:values.get('last_price_scan')??null,queued:counts?.queued??0,blocked:counts?.blocked??0 };
  }
}
