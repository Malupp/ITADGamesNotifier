import type { BotSession } from "./session.js";
import type { PriceQuote } from "../domain/models.js";
import { ApiError } from "../infrastructure/http.js";
import { money } from "./formatters.js";
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
export async function handleCallback(session: BotSession): Promise<void> {
  const {
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
  } = session;
  if (!callback) return;
  // Expired callback acknowledgements never prevent an otherwise valid operation.
  try {
    await context.telegram.answerCallback(callback.id);
  } catch {
    /* noncritical */
  }
  const [action, gameId, value] = (callback.data ?? "").split("|");
  if (action === "cancel") {
    await reply("✅ Operazione annullata.");
    return;
  }
  if (["wishlistpage", "rempage", "discpage"].includes(action)) {
    if (!isPrivate) {
      await privateOnly();
      return;
    }
    const offset = number(gameId);
    if (offset === null || !Number.isSafeInteger(offset) || offset < 0) return;
    await wishlistPage(
      action === "wishlistpage"
        ? "wishlist"
        : action === "rempage"
          ? "remove"
          : "discount",
      offset,
    );
    return;
  }
  if (
    !["price", "addwish", "remwish", "setscontog", "setscontog_apply"].includes(
      action,
    )
  )
    return;
  if (action !== "price" && !isPrivate) {
    await privateOnly();
    return;
  }
  if (!gameId || !UUID.test(gameId)) {
    await reply(
      "❌ Selezione scaduta o non valida. Riprova /cerca, /add o /setscontog.",
    );
    return;
  }
  if (action === "price" || action === "addwish") {
    const game = await context.itad.getGameInfo(gameId);
    if (!game || game.id !== gameId) {
      await reply("❌ Gioco completo non trovato. Riprova /cerca o /add.");
      return;
    }
    if (action === "price") {
      await showPrices(game);
      return;
    }
    let quote: PriceQuote | null = null;
    try {
      quote = best((await context.itad.getPrices([gameId])).get(gameId));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
    const added = await context.wishlist.addWishlist(
      userId,
      username,
      game,
      quote,
    );
    const already =
      !added &&
      (await context.wishlist.getWishlist(userId)).some(
        (item) => item.game_id === game.id,
      );
    await reply(
      added
        ? `✅ <b>${html(game.title)}</b> aggiunto alla wishlist${quote ? ` (${money(quote.priceCents)})` : ""}.\nControllo ogni 30 minuti; il prezzo iniziale viene registrato senza notifiche.`
        : already
          ? `ℹ️ <b>${html(game.title)}</b> è già nella tua wishlist.`
          : "ℹ️ Capacità raggiunta: il servizio gratuito monitora fino a 200 giochi distinti. Rimuovi un gioco prima di aggiungerne uno nuovo.",
    );
    return;
  }
  const item = (await context.wishlist.getWishlist(userId)).find(
    (item) => item.game_id === gameId,
  );
  if (!item) {
    await reply("❌ Gioco non trovato nella tua wishlist.");
    return;
  }
  if (action === "remwish") {
    await context.wishlist.removeWishlist(userId, gameId);
    await reply(`✅ <b>${html(item.title)}</b> rimosso dalla wishlist.`);
    return;
  }
  if (action === "setscontog") {
    const rows = [
      [button("🌐 Usa soglia globale", `setscontog_apply|${gameId}|None`)],
    ];
    for (const values of [
      [10, 20, 30],
      [40, 50, 60],
      [70, 75, 80],
    ])
      rows.push(
        values.map((pct) =>
          button(`${pct}%`, `setscontog_apply|${gameId}|${pct}`),
        ),
      );
    rows.push(cancel);
    await reply(
      `🎮 <b>${html(item.title)}</b>\nSoglia attuale: ${item.min_discount_pct === null ? "globale" : `${item.min_discount_pct}%`}. Scegli il ribasso:`,
      keyboard(rows),
    );
    return;
  }
  const pct = value === "None" ? null : percent(value, 10, 99);
  if (value !== "None" && pct === null) {
    await reply("❌ La soglia deve essere fra 10% e 99%.");
    return;
  }
  await context.wishlist.setWishlistDiscount(userId, gameId, pct);
  await reply(
    `✅ <b>${html(item.title)}</b>: ${pct === null ? "usa la soglia globale" : `ribasso minimo ${pct}% rispetto all’ultima notifica consegnata`}.`,
  );
  return;
}
