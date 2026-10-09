import type { Offer } from "./models.js";
import { safeUrl } from "./urls.js";
export function normalizeGiveaways(raw: unknown[], now: number): Offer[] {
  const offers = new Map<string, Offer>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, any>;
    if (
      !Number.isSafeInteger(item.id) ||
      !item.shop ||
      typeof item.shop.name !== "string"
    )
      continue;
    if (
      /\b(prime|subscription|game\s?pass|playstation\s?plus)\b/i.test(
        item.shop.name,
      )
    )
      continue;
    // Unknown prerequisites are not evidence that an Italian user can claim it.
    if (
      item.note != null &&
      (typeof item.note !== "string" ||
        (item.note.trim() &&
          item.note.trim() !== "* Giveaway previously offered."))
    )
      continue;
    if (
      /\b(mobile|android|ios|demo|trial|weekend|dlc|f2p|subscription|prime)\b/i.test(
        String(item.title ?? ""),
      )
    )
      continue;
    const url = safeUrl(item.url);
    if (!url) continue;
    const expiry = item.expiry == null ? null : Date.parse(item.expiry);
    if (expiry !== null && (!Number.isFinite(expiry) || expiry <= now))
      continue;
    if (!Array.isArray(item.games)) continue;
    for (const game of item.games) {
      if (
        !game ||
        game.type !== "game" ||
        typeof game.id !== "string" ||
        typeof game.slug !== "string" ||
        typeof game.title !== "string"
      )
        continue;
      if (
        !Array.isArray(game.platforms) ||
        !game.platforms.some((p: any) => p && [1, 2, 3].includes(p.id))
      )
        continue;
      const id = `itad:${item.id}:${game.id}`;
      offers.set(id, {
        id,
        gameId: game.id,
        slug: game.slug,
        title: game.title,
        shop: item.shop.name,
        url,
        expiry,
      });
    }
  }
  return [...offers.values()];
}
