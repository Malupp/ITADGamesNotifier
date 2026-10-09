import type { ApplicationContext } from "../application/context.js";
import type { Game, TelegramUpdate } from "../domain/models.js";
import { ApiError } from "../infrastructure/http.js";
import { money, quoteText } from "./formatters.js";
import { showWishlist } from "./wishlist.js";
import {
  SHOPS,
  SHOP_IDS,
  PAGE_SIZE,
  UUID,
  PRIVATE_COMMANDS,
  COMMANDS,
  html,
  button,
  keyboard,
  cancel,
  number,
  percent,
  priceArg,
  best,
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
  const reply = (text: string, markup?: unknown) =>
    context.deliveries.queueMessage(
      `reply:${update.update_id}:${ordinal++}`,
      chatId,
      text,
      markup,
    );
  const privateOnly = () =>
    reply("🔒 Gestisci wishlist e preferenze nella chat privata con il bot.");

  async function showPrices(game: Game, trackedOnly = false) {
    let quotes = (await itad.getPrices([game.id])).get(game.id) ?? [];
    if (trackedOnly)
      quotes = quotes.filter((quote) => SHOP_IDS.includes(quote.shopId));
    quotes.sort((a, b) => a.priceCents - b.priceCents);
    if (!quotes.length) {
      await reply(
        `😔 Nessun prezzo disponibile per <b>${html(game.title)}</b>.`,
      );
      return;
    }
    for (const quote of quotes.slice(0, 8))
      await reply(`🎮 <b>${html(game.title)}</b>\n${quoteText(quote)}`);
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
    privateOnly,
    showPrices,
    wishlistPage,
  };
}
export type BotSession = NonNullable<ReturnType<typeof createSession>>;
