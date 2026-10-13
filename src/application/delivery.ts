import { measure } from "./telemetry.js";
import type { ApplicationContext } from "./context.js";
import type { Delivery, ReplyMedia } from "../domain/models.js";
import { ApiError } from "../infrastructure/http.js";
import { enabled, backoff, errorCode } from "./retries.js";
import { publishJobs } from "../runtime/queues.js";
import { formatGiveaway, formatPrice } from "../telegram/formatters.js";
import { revalidateKeyDelivery } from "./keys.js";
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
  const activity = await context.preferences.privateActivity(d.chat_id);
  let attemptedAt = now;
  let replyMedia: ReplyMedia | undefined;
  try {
    replyMedia = d.reply_media ? JSON.parse(d.reply_media) : undefined;
    if (
      (d.kind !== "giveaway" && !/^[1-9]\d*$/.test(d.chat_id)) ||
      (d.kind === "giveaway" && (
        d.chat_id !== context.env.TELEGRAM_CHAT_ID ||
        await context.telegram.getChatType(d.chat_id) !== "channel"
      ))
    ) {
      await context.deliveries.expireDelivery(d);
      return null;
    }
    let text = d.text;
    let photo: string | null | undefined;
    let previewUrl: string | undefined;
    // Recheck wishlist prices immediately before sending, including rebound/removal.
    if (d.kind === "price" && d.source && d.source !== "itad") {
      const current = await revalidateKeyDelivery(context, d, now);
      if (current === null) {
        await context.deliveries.expireDelivery(d);
        return null;
      }
      text = current;
    }
    if (d.kind === "price" && d.game_id && (!d.source || d.source === "itad")) {
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
      photo = valid[0].imageUrl;
    }
    const markup = d.reply_markup ? JSON.parse(d.reply_markup) : undefined;
    if (replyMedia?.originMessageId != null && await context.deliveries.isObsoleteEdit(d)) {
      await context.deliveries.expireDelivery(d);
      return null;
    }
    attemptedAt = Math.max(now, context.now());
    if (d.operation === "edit") {
      if (d.kind !== "reply" || d.telegram_message_id === null)
        throw new ApiError(400, undefined, true);
      if (replyMedia?.isPhoto && !replyMedia.photoUrl && replyMedia.previewUrl)
        return textMediaFallback(context, d, text, markup, replyMedia.previewUrl, now);
      await measure(
        "delivery",
        async () => {
          if (replyMedia?.photoUrl) {
            try {
              await context.telegram.editPhoto(d.chat_id, d.telegram_message_id!, text, replyMedia.photoUrl, markup);
            } catch (error) {
              if (!(error instanceof ApiError) || error.status !== 400 || error.telegramReason || replyMedia.isPhoto) throw error;
              // A rejected cover on an existing text message can stay text.
              await context.telegram.editMessage(d.chat_id, d.telegram_message_id!, text, markup, replyMedia.previewUrl);
            }
          } else if (replyMedia?.isPhoto)
            await context.telegram.editCaption(d.chat_id, d.telegram_message_id!, text, markup);
          else {
            try {
              await context.telegram.editMessage(d.chat_id, d.telegram_message_id!, text, markup, replyMedia?.previewUrl);
            } catch (error) {
              if (!(error instanceof ApiError) || error.telegramReason !== "no_text" || replyMedia?.previewUrl) throw error;
              await context.telegram.editCaption(d.chat_id, d.telegram_message_id!, text, markup);
            }
          }
        },
        context.recordTiming,
      );
    } else
      await measure(
        "delivery",
        () => d.kind === "giveaway"
          ? context.telegram.sendIllustrated(d.chat_id, text, photo, previewUrl)
          : d.kind === "reply" && replyMedia
            ? context.telegram.sendIllustrated(d.chat_id, text, replyMedia.photoUrl, replyMedia.previewUrl, markup)
            : context.telegram.sendMessage(d.chat_id, text, markup, previewUrl),
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
      d.operation === "edit" && replyMedia && (replyMedia.photoUrl || replyMedia.previewUrl) &&
      e instanceof ApiError && e.status === 400 && (!e.telegramReason || e.telegramReason === "no_text")
    ) {
      const markup = d.reply_markup ? JSON.parse(d.reply_markup) : undefined;
      return textMediaFallback(context, d, d.text, markup, replyMedia.previewUrl, now);
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
        Math.max(now, context.now()),
        activity,
        attemptedAt,
      );
      return null;
    }
    const delay = backoff(e, d.attempts);
    await context.deliveries.retryDelivery(d, now + delay * 1000, errorCode(e));
    return delay;
  }
}

/** Keep the old photo paired with its old caption; reopen an unavailable page as text. */
async function textMediaFallback(
  context: ApplicationContext, d: Delivery, text: string, markup: unknown,
  previewUrl: string | undefined, now: number,
): Promise<number | null> {
  if (await context.deliveries.isObsoleteEdit(d)) {
    await context.deliveries.expireDelivery(d);
    return null;
  }
  try {
    const id = await context.deliveries.queueMessage(
      `${d.id}:media-text`, d.chat_id, text, markup, d.expires_at,
      { previewUrl, originMessageId: d.telegram_message_id ?? undefined, originRevision: d.view_revision ?? undefined },
    );
    await publishJobs(context, [{ kind: "delivery", id }], "interactive");
    await context.deliveries.expireDelivery(d);
    return null;
  } catch (error) {
    const delay = backoff(error, d.attempts);
    await context.deliveries.retryDelivery(d, now + delay * 1000, errorCode(error));
    return delay;
  }
}
