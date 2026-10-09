import type { ApplicationContext } from "./context.js";
import type { Delivery, Game, PriceQuote } from "../domain/models.js";
import { bestRetail, isKeyBargain, keyDrop } from "../domain/key-pricing.js";
import { keyText } from "../infrastructure/d1/keys.js";
import { escapeHtml } from "../telegram/formatters.js";
import { ApiError } from "../infrastructure/http.js";
import { backoff, enabled, errorCode } from "./retries.js";
import { flushDeliveries, sendJobs } from "../runtime/queues.js";

export const keysEnabled = (c: ApplicationContext) =>
  c.env.KEYSHOPS_ENABLED === "true" && Boolean(c.env.GGDEALS_API_KEY);
const targets = (c: ApplicationContext) => [
  ...new Set(
    [c.env.TELEGRAM_CHAT_ID, c.env.TELEGRAM_CHAT_GROUP].filter(
      (s): s is string => Boolean(s),
    ),
  ),
];
export async function ggPrices(
  c: ApplicationContext,
  ids: number[],
  now: number,
) {
  ids = [...new Set(ids)];
  if (!ids.length) return new Map();
  await c.keys.reserve(ids.length, now);
  try {
    return await c.gg.getPrices(ids);
  } catch (e) {
    if (e instanceof ApiError && e.status === 429)
      await c.keys.blockUntil(now + Math.max(60, e.retryAfter ?? 60) * 1000);
    throw e;
  }
}
export async function publishKeys(c: ApplicationContext, now: number) {
  const ids = await c.keyScans.dispatch(now);
  try {
    await sendJobs(
      c,
      ids.map((id) => ({ kind: "keyscan", id })),
    );
  } catch (e) {
    await c.keyScans.releaseDispatch(ids, now);
    throw e;
  }
}
export async function scheduleKeys(
  c: ApplicationContext,
  now: number,
  initialize = false,
) {
  if (!keysEnabled(c) || !enabled(c)) return;
  const quiet =
    initialize || (await c.settings.getSetting("keys_seeded")) !== "true";
  await c.keyScans.start(
    "keys",
    [{ kind: "keys", phase: "discover", ids: [], offset: 0, quiet }],
    quiet,
    now,
  );
  await publishKeys(c, now);
}
export async function processKeyScan(
  id: string,
  c: ApplicationContext,
  now: number,
): Promise<number | null> {
  const claim = await c.keyScans.claim(id, now);
  if (!claim) {
    await sendJobs(
      c,
      (await c.keyScans.successors(id, now)).map((id) => ({
        kind: "keyscan",
        id,
      })),
    );
    if (keysEnabled(c) && enabled(c)) await flushDeliveries(c, now);
    return null;
  }
  if (!keysEnabled(c) || !enabled(c)) {
    await c.keyScans.retry(id, claim.token, now + 1800000);
    return null;
  }
  const task = claim.task;
  try {
    let next: typeof task | undefined;
    if (task.phase === "discover") {
      const last = Number(
        (await c.settings.getSetting("key_discovery_at")) ?? 0,
      );
      if (!last || now - last >= 86400000) {
        const popular = await c.itad.getPopularGames(100);
        const deals = await c.itad.getDeals({
          maxPriceCents: 10000,
          limit: 30,
        });
        const pool = [
          ...new Map(
            [...popular, ...deals.map((d) => d.game)].map((g) => [g.id, g]),
          ).values(),
        ].slice(0, 130);
        await c.keys.selectPool(pool, now);
      }
      const ids = await c.keys.ids();
      if (ids.length > 330) throw new ApiError(502);
      next = ids.length ? { ...task, phase: "map", ids, offset: 0 } : undefined;
    } else if (task.phase === "map") {
      const gameId = task.ids[task.offset],
        old = await c.keys.mapping(gameId);
      if (!old || old.at === 0 || now - old.at >= 7 * 86400000) {
        const info = await c.itad.getGameInfo(gameId);
        if (info && info.id !== gameId) throw new ApiError(502);
        await c.keys.map(
          gameId,
          info?.title ?? gameId,
          info?.steamAppId ?? null,
          now,
        );
      }
      // Skip all fresh mappings in one bounded database read on the next run.
      let offset = task.offset + 1;
      const fresh = (
        await c.env.DB.prepare(
          "SELECT game_id FROM key_games WHERE mapped_at>0 AND mapped_at>?",
        )
          .bind(now - 7 * 86400000)
          .all<{ game_id: string }>()
      ).results;
      const cached = new Set(fresh.map((r) => r.game_id));
      while (offset < task.ids.length && cached.has(task.ids[offset])) offset++;
      next =
        offset < task.ids.length
          ? { ...task, offset }
          : { ...task, phase: "prices", offset: 0 };
    } else {
      const ids = task.ids.slice(task.offset, task.offset + 20);
      const mapped = (
        await c.env.DB.prepare(
          "SELECT game_id,steam_app_id FROM key_games WHERE game_id IN (SELECT value FROM json_each(?)) AND steam_app_id IS NOT NULL",
        )
          .bind(JSON.stringify(ids))
          .all<{ game_id: string; steam_app_id: number }>()
      ).results;
      const prices = await ggPrices(
        c,
        mapped.map((r) => r.steam_app_id),
        now,
      );
      const official = await c.itad.getPrices(mapped.map((r) => r.game_id));
      await c.keys.observeMany(
        mapped.map((m) => {
          const p = prices.get(m.steam_app_id) ?? null;
          return {
            id: m.game_id,
            price: p,
            retail: bestRetail(
              p?.retailCents ?? null,
              ...(official.get(m.game_id) ?? []).map((q) => q.priceCents),
            ),
          };
        }),
        now,
        task.quiet,
        targets(c),
      );
      next =
        task.offset + 20 < task.ids.length
          ? { ...task, offset: task.offset + 20 }
          : undefined;
    }
    await c.keyScans.complete(id, claim.token, claim.runId, now, next);
    await publishKeys(c, now);
    if (!task.quiet) await flushDeliveries(c, now);
    return null;
  } catch (e) {
    const delay = backoff(e, claim.attempts);
    await c.keyScans.retry(id, claim.token, now + delay * 1000);
    await c.settings.setSetting("last_key_error", errorCode(e), now);
    return delay;
  }
}
// UI falls back to authorized offers; it never silently uses an expired key quote.
export async function interactiveKeys(
  c: ApplicationContext,
  games: Game[],
  mapUnknown = false,
  official?: Map<string, PriceQuote[]>,
) {
  if (!keysEnabled(c)) return new Map();
  try {
    if (mapUnknown && games.length === 1) {
      const g = games[0],
        old = await c.keys.mapping(g.id);
      if (!old || old.at === 0 || c.now() - old.at >= 7 * 86400000) {
        const info =
          g.steamAppId !== undefined ? g : await c.itad.getGameInfo(g.id);
        if (info && info.id !== g.id) throw new ApiError(502);
        await c.keys.map(
          g.id,
          info?.title ?? g.title,
          info?.steamAppId ?? null,
          c.now(),
        );
      }
    }
    const ids = games.map((g) => g.id),
      cached = await c.keys.prices(ids);
    const rows = (
      await c.env.DB.prepare(
        "SELECT game_id,steam_app_id FROM key_games WHERE game_id IN (SELECT value FROM json_each(?)) AND steam_app_id IS NOT NULL",
      )
        .bind(JSON.stringify(ids))
        .all<{ game_id: string; steam_app_id: number }>()
    ).results;
    const stale = rows.filter(
      (r) =>
        !cached.has(r.game_id) ||
        c.now() - cached.get(r.game_id)!.observedAt >= 1800000,
    );
    if (stale.length) {
      const prices = await ggPrices(
        c,
        stale.map((r) => r.steam_app_id),
        c.now(),
      );
      const retail =
        official ?? (await c.itad.getPrices(stale.map((r) => r.game_id)));
      await c.keys.observeMany(
        stale.map((r) => ({
          id: r.game_id,
          price: prices.get(r.steam_app_id) ?? null,
          retail: bestRetail(
            prices.get(r.steam_app_id)?.retailCents ?? null,
            ...(retail.get(r.game_id) ?? []).map((q) => q.priceCents),
          ),
        })),
        c.now(),
        true,
        [],
        true,
      );
    }
    if (official) await c.keys.compareRetail(official);
    const current = await c.keys.prices(ids);
    return new Map(
      [...current].filter(([, p]) => c.now() - p.observedAt < 3600000),
    );
  } catch {
    return new Map();
  }
}
export async function revalidateKeyDelivery(
  c: ApplicationContext,
  d: Delivery,
  now: number,
): Promise<string | null> {
  if (!keysEnabled(c) || !d.game_id) return null;
  let mapping = await c.keys.mapping(d.game_id);
  if (mapping && now - mapping.at >= 7 * 86400000) {
    const info = await c.itad.getGameInfo(d.game_id);
    if (info && info.id !== d.game_id) throw new ApiError(502);
    const changed = (info?.steamAppId ?? null) !== mapping.appId;
    await c.keys.map(
      d.game_id,
      info?.title ?? d.game_id,
      info?.steamAppId ?? null,
      now,
    );
    if (changed) return null;
    mapping = await c.keys.mapping(d.game_id);
  }
  if (!mapping?.appId || mapping.appId !== d.key_app_id) return null;
  const prices = await ggPrices(c, [mapping.appId], now),
    p = prices.get(mapping.appId) ?? null;
  const official = await c.itad.getPrices([d.game_id]);
  const retail = bestRetail(
    p?.retailCents ?? null,
    ...(official.get(d.game_id) ?? []).map((q) => q.priceCents),
  );
  await c.keys.observe(d.game_id, p, retail, now, true, targets(c), true);
  if (
    !p ||
    p.keyCents !== d.price_cents ||
    p.keyCents === null ||
    p.keyCents <= 0
  )
    return null;
  const mode = d.source === "keyshop" ? "wishlist" : "general";
  const state = await c.env.DB.prepare(
    "SELECT * FROM key_alert_state WHERE mode=? AND owner_id=? AND game_id=?",
  )
    .bind(mode, d.wishlist_user_id, d.game_id)
    .first<any>();
  if (!state || state.generation !== d.price_generation) return null;
  if (mode === "wishlist") {
    const item = await c.env.DB.prepare(
      "SELECT title,added_at,min_discount_pct FROM wishlist WHERE user_id=? AND game_id=?",
    )
      .bind(d.wishlist_user_id, d.game_id)
      .first<any>();
    if (
      !item ||
      state.generation !== item.added_at ||
      !keyDrop(
        state.notified ?? state.baseline,
        p.keyCents,
        item.min_discount_pct ??
          (await c.preferences.getPrefs(d.wishlist_user_id!)).minDiscountPct,
      )
    )
      return null;
    p.title = item.title;
  } else if (
    !targets(c).includes(d.chat_id) ||
    !isKeyBargain(p.keyCents, retail) ||
    !(
      keyDrop(state.notified ?? state.baseline, p.keyCents, 10) ||
      (state.notified === null &&
        (state.baseline === null || state.baseline === p.keyCents))
    )
  )
    return null;
  return `🔔 <b>${mode === "wishlist" ? "Ribasso key wishlist" : "Affare key"}</b>\n🎮 <b>${escapeHtml(p.title)}</b>\n${keyText({ ...p, retailCents: retail }, now)}`;
}
