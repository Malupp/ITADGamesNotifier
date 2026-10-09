import { measure } from "./telemetry.js";
import type { ApplicationContext } from "./context.js";
import { ApiError } from "../infrastructure/http.js";
import { enabled, backoff, errorCode } from "./retries.js";
import { publishJobs } from "../runtime/queues.js";
import { formatGiveaway, formatPrice } from "../telegram/formatters.js";
import {
  verifyGiveaways,
  confirmOfficialGiveaways,
} from "../infrastructure/stores/verification.js";

export async function processDelivery(
  id: string,
  context: ApplicationContext,
  now: number,
): Promise<number | null> {
  const d = await context.deliveries.claimDelivery(id, now);
  if (!d) return context.deliveries.pendingEditDelay(id, now);
  context.recordTiming({
    stage: d.attempts === 1 ? "delivery_queue_first" : "delivery_queue_retry",
    durationMs: Math.max(0, now - d.due_at),
    outcome: "ok",
  });
  if (await context.deliveries.isObsoleteEdit(d)) {
    await context.deliveries.expireDelivery(d);
    return null;
  }
  if (d.kind !== "reply" && !enabled(context)) {
    await context.deliveries.retryDelivery(d, now + 1800000, "paused");
    return null;
  }
  try {
    let text = d.text;
    let previewUrl: string | undefined;
    // Recheck wishlist prices immediately before sending, including rebound/removal.
    if (d.kind === "price" && d.game_id) {
      const quotes = await context.itad.getPrices([d.game_id]);
      const best = (quotes.get(d.game_id) ?? []).sort(
        (a, b) => a.priceCents - b.priceCents,
      )[0];
      if (
        !best ||
        best.priceCents !== d.price_cents ||
        best.cut <= 0 ||
        best.regularCents === null ||
        best.regularCents <= best.priceCents
      ) {
        await context.deliveries.retryDelivery(d, now, "changed");
        await context.wishlist.invalidateMissingPrices([d.game_id], now);
        if (best) await context.wishlist.ingestPrices([best], now);
        await context.deliveries.cancelInvalidPending(now);
        return null;
      }
      const item = await context.env.DB.prepare(
        "SELECT title FROM wishlist WHERE user_id=? AND game_id=?",
      )
        .bind(d.wishlist_user_id, d.game_id)
        .first<{ title: string }>();
      if (!item) {
        await context.deliveries.expireDelivery(d);
        return null;
      }
      text = formatPrice(item.title, best);
    }
    if (d.kind === "giveaway") {
      const offer = await context.deliveries.deliveryOffer(d);
      const prices = offer
        ? await context.itad.getPrices([offer.gameId])
        : new Map();
      const valid = offer
        ? await confirmOfficialGiveaways(
            verifyGiveaways([offer], prices),
            context.fetcher,
            now,
          )
        : [];
      if (!valid.length) {
        await context.deliveries.expireDelivery(d);
        return null;
      }
      text = formatGiveaway(valid[0]);
      previewUrl = valid[0].url;
    }
    const markup = d.reply_markup ? JSON.parse(d.reply_markup) : undefined;
    if (d.operation === "edit") {
      if (d.kind !== "reply" || d.telegram_message_id === null)
        throw new ApiError(400, undefined, true);
      await measure(
        "delivery",
        () =>
          context.telegram.editMessage(
            d.chat_id,
            d.telegram_message_id!,
            text,
            markup,
          ),
        context.recordTiming,
      );
    } else
      await measure(
        "delivery",
        () => context.telegram.sendMessage(d.chat_id, text, markup, previewUrl),
        context.recordTiming,
      );
    await context.deliveries.completeDelivery(d, Date.now());
    return null;
  } catch (e) {
    if (
      d.operation === "edit" &&
      e instanceof ApiError &&
      e.telegramReason === "not_modified"
    ) {
      await context.deliveries.completeDelivery(d, Date.now());
      return null;
    }
    if (
      d.operation === "edit" &&
      e instanceof ApiError &&
      e.telegramReason === "message_missing"
    ) {
      const fallbackId = await context.deliveries.queueMessage(
        `${d.id}:reopen`,
        d.chat_id,
        "ℹ️ Questo messaggio non è più disponibile. Ripeti il comando (per esempio /wishlist) per riaprirlo.",
      );
      try {
        await publishJobs(
          context,
          [{ kind: "delivery", id: fallbackId }],
          "interactive",
        );
        await context.deliveries.expireDelivery(d);
        return null;
      } catch (publicationError) {
        const delay = backoff(publicationError, d.attempts);
        await context.deliveries.retryDelivery(
          d,
          now + delay * 1000,
          errorCode(publicationError),
        );
        return delay;
      }
    }
    if (e instanceof ApiError && e.permanent) {
      await context.deliveries.blockDelivery(
        d,
        errorCode(e),
        e.status === 403,
        now,
      );
      return null;
    }
    const delay = backoff(e, d.attempts);
    await context.deliveries.retryDelivery(d, now + delay * 1000, errorCode(e));
    return delay;
  }
}
