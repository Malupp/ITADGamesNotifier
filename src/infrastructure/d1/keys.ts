import { bestRetail } from "../../domain/key-pricing.js";
import { ApiError } from "../http.js";
import type { GgPrices } from "../../domain/key-pricing.js";
import { escapeHtml, money, formatExpiry } from "../../telegram/formatters.js";

export interface KeyPrice extends GgPrices {
  gameId: string;
  observedAt: number;
  ggRetailCents: number | null;
}
export function keyText(p: GgPrices, at: number, heading = "Minimo keyshop") {
  return (
    `🔑 <b>${heading}: ${p.keyCents === null ? "non disponibile" : money(p.keyCents)}</b>\n` +
    (p.retailCents === null
      ? ""
      : `🏪 Miglior prezzo autorizzato: ${money(p.retailCents)}\n`) +
    `<a href="${escapeHtml(p.url)}">Confronta su GG.deals</a> · ${formatExpiry(at)} (Italia)\n` +
    "Verifica negozio, commissioni e regione di attivazione. GG.deals aggiorna i dati circa ogni ora."
  );
}
export class KeysRepository {
  constructor(readonly db: D1Database) {}
  async reserve(count: number, now: number): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100)
      throw new ApiError(400);
    const minute = Math.floor(now / 60000),
      hour = Math.floor(now / 3600000);
    const row = await this.db
      .prepare(
        `UPDATE key_budget SET minute=?,hour=?,
      minute_used=CASE WHEN minute=? THEN minute_used ELSE 0 END+?,
      hour_used=CASE WHEN hour=? THEN hour_used ELSE 0 END+?
      WHERE id=1 AND blocked_until<=? AND (CASE WHEN minute=? THEN minute_used ELSE 0 END)+?<=100
      AND (CASE WHEN hour=? THEN hour_used ELSE 0 END)+?<=900 RETURNING id`,
      )
      .bind(
        minute,
        hour,
        minute,
        count,
        hour,
        count,
        now,
        minute,
        count,
        hour,
        count,
      )
      .first();
    if (!row) {
      const b = await this.db
        .prepare("SELECT * FROM key_budget WHERE id=1")
        .first<any>();
      const until = Math.max(
        b.blocked_until,
        b.hour === hour && b.hour_used + count > 900
          ? (hour + 1) * 3600000
          : (minute + 1) * 60000,
      );
      throw new ApiError(429, Math.max(1, Math.ceil((until - now) / 1000)));
    }
  }
  async blockUntil(until: number) {
    await this.db
      .prepare(
        "UPDATE key_budget SET blocked_until=MAX(blocked_until,?) WHERE id=1",
      )
      .bind(until)
      .run();
  }
  async map(id: string, title: string, appId: number | null, now: number) {
    const changed =
      "EXISTS(SELECT 1 FROM key_games g WHERE g.game_id=? AND g.steam_app_id IS NOT ?)";
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM key_prices WHERE game_id=? AND ${changed}`)
        .bind(id, id, appId),
      this.db
        .prepare(`DELETE FROM key_alert_state WHERE game_id=? AND ${changed}`)
        .bind(id, id, appId),
      this.db
        .prepare(
          `UPDATE deliveries SET status='expired' WHERE source IN ('keyshop','keydeal') AND game_id=? AND status IN('pending','processing') AND ${changed}`,
        )
        .bind(id, id, appId),
      this.db
        .prepare(
          `INSERT INTO key_games(game_id,title,steam_app_id,mapped_at) VALUES(?,?,?,?)
      ON CONFLICT(game_id) DO UPDATE SET title=excluded.title,steam_app_id=excluded.steam_app_id,mapped_at=excluded.mapped_at`,
        )
        .bind(id, title, appId, now),
    ]);
  }
  async mapping(id: string) {
    return this.db
      .prepare(
        "SELECT steam_app_id AS appId,mapped_at AS at FROM key_games WHERE game_id=?",
      )
      .bind(id)
      .first<{ appId: number | null; at: number }>();
  }
  async selectPool(games: Array<{ id: string; title: string }>, now: number) {
    await this.db.batch([
      this.db.prepare("UPDATE key_games SET general=0"),
      this.db
        .prepare(
          `INSERT INTO key_games(game_id,title,steam_app_id,mapped_at,general)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.title'),NULL,0,1 FROM json_each(?) WHERE 1
      ON CONFLICT(game_id) DO UPDATE SET general=1,title=excluded.title`,
        )
        .bind(JSON.stringify(games)),
      this.db
        .prepare(
          "INSERT INTO settings(key,value,updated_at) VALUES('key_discovery_at',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        )
        .bind(String(now), now),
    ]);
  }
  async ids() {
    return (
      await this.db
        .prepare(
          "SELECT game_id FROM key_games WHERE general=1 UNION SELECT game_id FROM wishlist",
        )
        .all<{ game_id: string }>()
    ).results.map((x) => x.game_id);
  }
  async prices(ids: string[]): Promise<Map<string, KeyPrice>> {
    const rows = await this.db
      .prepare(
        `SELECT p.*,g.title FROM key_prices p JOIN key_games g USING(game_id) WHERE g.steam_app_id=p.app_id AND game_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(ids))
      .all<any>();
    return new Map(
      rows.results.map((r) => [
        r.game_id,
        {
          gameId: r.game_id,
          appId: r.app_id,
          title: r.title,
          url: r.url,
          keyCents: r.key_cents,
          retailCents: r.retail_cents,
          ggRetailCents: r.gg_retail_cents,
          historicalKeyCents: r.historical_key_cents,
          historicalRetailCents: r.historical_retail_cents,
          observedAt: r.observed_at,
        },
      ]),
    );
  }
  async compareRetail(official: Map<string, Array<{ priceCents: number }>>) {
    const prices = await this.prices([...official.keys()]);
    const values = [...prices].map(([id, p]) => ({
      id,
      retail: bestRetail(
        p.ggRetailCents,
        ...(official.get(id) ?? []).map((q) => q.priceCents),
      ),
    }));
    if (values.length)
      await this.db
        .prepare(
          `UPDATE key_prices SET retail_cents=json_extract(q.value,'$.retail') FROM json_each(?) q WHERE game_id=json_extract(q.value,'$.id')`,
        )
        .bind(JSON.stringify(values))
        .run();
  }
  async bargains(now: number) {
    const ids = (
      await this.db
        .prepare(
          `SELECT p.game_id FROM key_prices p JOIN key_games g USING(game_id)
      WHERE (g.general=1 OR EXISTS(SELECT 1 FROM wishlist w WHERE w.game_id=g.game_id)) AND p.observed_at>? AND p.key_cents>0 AND p.key_cents<=1000 AND p.retail_cents>0 AND p.key_cents*2<=p.retail_cents ORDER BY p.key_cents`,
        )
        .bind(now - 3600000)
        .all<{ game_id: string }>()
    ).results.map((r) => r.game_id);
    return [...(await this.prices(ids)).values()];
  }
  async observe(
    id: string,
    price: GgPrices | null,
    retail: number | null,
    now: number,
    quiet: boolean,
    targets: string[],
    recordOnly = false,
  ) {
    return this.observeMany(
      [{ id, price, retail }],
      now,
      quiet,
      targets,
      recordOnly,
    );
  }
  async observeMany(
    values: Array<{
      id: string;
      price: GgPrices | null;
      retail: number | null;
    }>,
    now: number,
    quiet: boolean,
    targets: string[],
    recordOnly = false,
  ) {
    if (!values.length) return;
    const data = JSON.stringify(
      values.map((v) => ({
        id: v.id,
        present: v.price !== null,
        ...v.price,
        retail: v.retail,
        text: v.price
          ? `🎮 <b>${escapeHtml(Array.from(v.price.title).slice(0, 100).join(""))}</b>\n${keyText({ ...v.price, retailCents: v.retail }, now)}`
          : "",
      })),
    );
    const owners = `WITH q AS (SELECT json_extract(value,'$.id') AS game_id,json_extract(value,'$.keyCents') AS price,json_extract(value,'$.retail') AS retail,json_extract(value,'$.text') AS text,json_extract(value,'$.appId') AS app_id FROM json_each(?)),
      owners AS (SELECT 'wishlist' AS mode,w.user_id AS owner,w.game_id,w.added_at AS generation,
        MAX(10,COALESCE(w.min_discount_pct,p.min_discount_pct,10)) AS threshold FROM wishlist w LEFT JOIN user_prefs p ON p.user_id=w.user_id JOIN q ON q.game_id=w.game_id
        UNION ALL SELECT 'general',c.value,q.game_id,0,10 FROM json_each(?) c CROSS JOIN q)`;
    const statements = [
      this.db
        .prepare(
          `INSERT INTO key_prices(game_id,app_id,key_cents,retail_cents,gg_retail_cents,historical_key_cents,historical_retail_cents,url,observed_at)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.appId'),json_extract(value,'$.keyCents'),json_extract(value,'$.retail'),json_extract(value,'$.retailCents'),json_extract(value,'$.historicalKeyCents'),json_extract(value,'$.historicalRetailCents'),json_extract(value,'$.url'),?
        FROM json_each(?) WHERE json_extract(value,'$.present')=1
        ON CONFLICT(game_id) DO UPDATE SET app_id=excluded.app_id,key_cents=excluded.key_cents,retail_cents=excluded.retail_cents,gg_retail_cents=excluded.gg_retail_cents,historical_key_cents=excluded.historical_key_cents,historical_retail_cents=excluded.historical_retail_cents,url=excluded.url,observed_at=excluded.observed_at`,
        )
        .bind(now, data),
      this.db
        .prepare(
          `UPDATE key_prices SET key_cents=NULL,retail_cents=NULL,observed_at=? WHERE game_id IN (SELECT json_extract(value,'$.id') FROM json_each(?) WHERE NOT json_extract(value,'$.present'))`,
        )
        .bind(now, data),
      this.db
        .prepare(
          `UPDATE key_alert_state SET observed=json_extract(q.value,'$.keyCents') FROM json_each(?) q WHERE game_id=json_extract(q.value,'$.id')`,
        )
        .bind(data),
      this.db
        .prepare(
          `UPDATE deliveries SET status='expired' WHERE source IN ('keyshop','keydeal') AND status='pending' AND EXISTS(SELECT 1 FROM json_each(?) q WHERE game_id=json_extract(q.value,'$.id') AND (json_extract(q.value,'$.keyCents') IS NULL OR price_cents!=json_extract(q.value,'$.keyCents') OR (source='keydeal' AND (json_extract(q.value,'$.retail') IS NULL OR json_extract(q.value,'$.retail')<=0 OR price_cents*2>json_extract(q.value,'$.retail')))))`,
        )
        .bind(data),
    ];
    if (!recordOnly) {
      if (!quiet)
        statements.push(
          this.db
            .prepare(
              `${owners}
        INSERT INTO deliveries(id,kind,source,chat_id,text,due_at,expires_at,wishlist_user_id,game_id,price_cents,price_generation,key_app_id)
        SELECT (CASE WHEN o.mode='wishlist' THEN 'keyshop' ELSE 'keydeal' END)||':'||o.owner||':'||o.game_id||':'||o.generation||':'||q.app_id||':'||COALESCE(k.notified,k.baseline,'new')||':'||q.price,
          'price',CASE WHEN o.mode='wishlist' THEN 'keyshop' ELSE 'keydeal' END,o.owner,
          '🔔 <b>'||(CASE WHEN o.mode='wishlist' THEN 'Ribasso key wishlist' ELSE 'Affare key' END)||'</b>\n'||q.text,?,?,o.owner,o.game_id,q.price,o.generation,q.app_id
        FROM owners o JOIN q ON q.game_id=o.game_id LEFT JOIN key_alert_state k ON k.mode=o.mode AND k.owner_id=o.owner AND k.game_id=o.game_id AND k.generation=o.generation
        WHERE q.price>0 AND ((o.mode='wishlist' AND COALESCE(k.notified,k.baseline)>0 AND q.price*100<=COALESCE(k.notified,k.baseline)*(100-o.threshold))
          OR (o.mode='general' AND q.price<=1000 AND q.retail>0 AND q.price*2<=q.retail AND (COALESCE(k.notified,k.baseline) IS NULL OR q.price*100<=COALESCE(k.notified,k.baseline)*90)))
        AND NOT EXISTS(SELECT 1 FROM blocked_chats WHERE chat_id=o.owner)
        AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.source=CASE WHEN o.mode='wishlist' THEN 'keyshop' ELSE 'keydeal' END AND d.wishlist_user_id=o.owner AND d.game_id=o.game_id AND d.status IN('pending','processing'))
        ON CONFLICT(id) DO UPDATE SET status='pending',due_at=excluded.due_at,expires_at=excluded.expires_at,text=excluded.text,key_app_id=excluded.key_app_id,price_generation=excluded.price_generation,lease_until=NULL,lease_token=NULL,attempts=0 WHERE deliveries.status='expired'`,
            )
            .bind(data, JSON.stringify(targets), now, now + 1800000),
        );
      statements.push(
        this.db
          .prepare(
            `${owners} INSERT INTO key_alert_state(mode,owner_id,game_id,baseline,observed,generation)
        SELECT o.mode,o.owner,o.game_id,CASE WHEN q.price>0 AND (o.mode='wishlist' OR (? AND q.price<=1000 AND q.retail>0 AND q.price*2<=q.retail)) THEN q.price ELSE NULL END,q.price,o.generation FROM owners o JOIN q ON q.game_id=o.game_id WHERE 1
        ON CONFLICT(mode,owner_id,game_id) DO UPDATE SET observed=excluded.observed,
        baseline=CASE WHEN generation!=excluded.generation THEN excluded.baseline ELSE COALESCE(baseline,excluded.baseline) END,
        notified=CASE WHEN generation!=excluded.generation THEN NULL ELSE notified END,generation=excluded.generation`,
          )
          .bind(data, JSON.stringify(targets), Number(quiet)),
      );
    }
    // Six set-based queries irrespective of page size/watchers, beneath D1 Free's 50-query limit.
    await this.db.batch(statements);
  }
}
