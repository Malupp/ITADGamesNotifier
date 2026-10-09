import type { ApplicationContext } from "../application/context.js";
import type { Game, TelegramUpdate } from "../domain/models.js";
import { formatExpiry, quoteText } from "./formatters.js";
import { showWishlist } from "./wishlist.js";
import { resultPages, saveView } from "./result-pages.js";
import { interactiveKeys, keysEnabled } from "../application/keys.js";
import { keyText } from "../infrastructure/d1/keys.js";
import {
  SHOP_IDS,
  PAGE_SIZE,
  html,
  button,
  keyboard,
  cancel,
} from "./options.js";

export function createSession(
  context: ApplicationContext,
  update: TelegramUpdate,
) {
  const callback = update.callback_query,
    message = update.message;
  const user = callback?.from ?? message?.from;
  const chat = callback?.message?.chat ?? message?.chat;
  if (!user || !chat) return null;
  const userId = String(user.id),
    chatId = String(chat.id),
    username = user.username ?? user.first_name ?? null;
  const isPrivate =
    chat.id === user.id &&
    (!message ||
      message.chat.type === undefined ||
      message.chat.type === "private");
  const itad = context.itad;
  let ordinal = 0;
  const reply = (text: string, markup?: unknown, expiresAt?: number) => {
    const key = `reply:${update.update_id}:${ordinal++}`;
    const messageId = callback?.message?.message_id;
    return messageId === undefined
      ? context.deliveries.queueMessage(key, chatId, text, markup, expiresAt)
      : context.deliveries.queueEdit(
          key,
          chatId,
          messageId,
          text,
          update.update_id,
          markup ?? { inline_keyboard: [] },
          expiresAt,
        );
  };
  const privateOnly = () =>
    reply("🔒 Gestisci wishlist e preferenze nella chat privata con il bot.");

  async function showList(
    title: string,
    blocks: string[],
    backId?: string,
    expiresAt?: number,
  ) {
    const page = await saveView(
      context,
      String(update.update_id),
      userId,
      chatId,
      resultPages(title, blocks),
      backId,
      expiresAt,
    );
    await reply(page.text, page.replyMarkup, page.expiresAt);
  }

  async function showPrices(game: Game, trackedOnly = false, backId?: string) {
    const official = await itad.getPrices([game.id]);
    let quotes = official.get(game.id) ?? [];
    if (trackedOnly)
      quotes = quotes.filter((quote) => SHOP_IDS.includes(quote.shopId));
    quotes.sort((a, b) => a.priceCents - b.priceCents);
    const key = (await interactiveKeys(context, [game], true, official)).get(
      game.id,
    );
    if (!quotes.length && !key?.keyCents) {
      await showList(
        "",
        [`😔 Nessun prezzo disponibile per <b>${html(game.title, 100)}</b>.`],
        backId,
      );
      return;
    }
    await showList(
      `🎮 <b>${html(game.title, 100)}</b>\nPrezzi rilevati il ${formatExpiry(context.now())} (Italia), EUR`,
      [
        ...(key?.keyCents
          ? [keyText(key, key.observedAt)]
          : keysEnabled(context)
            ? ["🔑 Prezzi key non disponibili al momento per questo gioco."]
            : []),
        ...quotes.map(quoteText),
      ],
      backId,
      key
        ? Math.min(context.now() + 86400000, key.observedAt + 3600000)
        : undefined,
    );
  }
  async function wishlistPage(
    mode: "wishlist" | "remove" | "discount",
    offset = 0,
  ) {
    if (mode === "wishlist") {
      await showWishlist(
        context,
        userId,
        chatId,
        update.update_id,
        offset,
        callback?.message?.message_id,
      );
      return;
    }
    const items = await context.wishlist.getWishlist(userId);
    if (!items.length) {
      await reply(
        "📋 La tua wishlist è vuota. Usa /add &lt;titolo&gt; per aggiungere giochi.",
      );
      return;
    }
    const page = items.slice(offset, offset + PAGE_SIZE);
    if (!page.length) {
      await reply("Pagina non disponibile. Riapri /wishlist.");
      return;
    }
    const rows: ReturnType<typeof button>[][] = page.map((item) => [
      button(
        mode === "remove"
          ? "❌ " + item.title
          : item.title +
              " (" +
              (item.min_discount_pct ?? "globale") +
              (item.min_discount_pct === null ? "" : "%") +
              ")",
        (mode === "remove" ? "remwish" : "setscontog") + "|" + item.game_id,
      ),
    ]);
    const prefix = mode === "remove" ? "rempage" : "discpage";
    const navigation: ReturnType<typeof button>[] = [];
    if (offset > 0)
      navigation.push(
        button("◀️ Indietro", prefix + "|" + Math.max(0, offset - PAGE_SIZE)),
      );
    if (offset + PAGE_SIZE < items.length)
      navigation.push(
        button("Altri giochi ▶️", prefix + "|" + (offset + PAGE_SIZE)),
      );
    if (navigation.length) rows.push(navigation);
    rows.push(cancel);
    await reply(
      mode === "remove"
        ? "Seleziona il gioco da rimuovere:"
        : "Seleziona il gioco per impostare il ribasso minimo:",
      keyboard(rows),
    );
  }

  return {
    context,
    update,
    callback,
    message,
    userId,
    chatId,
    username,
    isPrivate,
    reply,
    showList,
    privateOnly,
    showPrices,
    wishlistPage,
  };
}
export type BotSession = NonNullable<ReturnType<typeof createSession>>;
