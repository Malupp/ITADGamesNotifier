import type { ApplicationContext } from "../application/context.js";
import type { PriceQuote, WishlistItem } from "../domain/models.js";
import { safeUrl } from "../domain/urls.js";
import { escapeHtml, formatExpiry, money } from "./formatters.js";

const PAGE_SIZE = 10,
  MAX_TEXT = 3800;
const clip = (value: string, limit: number) =>
  escapeHtml(Array.from(value).slice(0, limit).join(""));
const pageOffset = (length: number, offset: number) =>
  length === 0
    ? 0
    : offset >= length
      ? Math.floor((length - 1) / PAGE_SIZE) * PAGE_SIZE
      : Math.max(0, offset);
export function buildWishlistPage(
  items: WishlistItem[],
  prices: Map<string, PriceQuote[]>,
  offset: number,
): { text: string; replyMarkup?: unknown; nextOffset: number | null } {
  if (!items.length)
    return {
      text: "📋 La tua wishlist è vuota. Usa /add &lt;titolo&gt; per aggiungere giochi.",
      nextOffset: null,
    };
  offset = pageOffset(items.length, offset);
  const header = (end: number) =>
    `📋 <b>La tua wishlist</b> · ${offset + 1}–${end} di ${items.length}\n\n`;
  const footer =
    "\n\nPrezzi da IsThereAnyDeal, richiesti al momento dell’apertura.";
  let body = "",
    end = offset;
  for (const item of items.slice(offset, offset + PAGE_SIZE)) {
    const quote = (prices.get(item.game_id) ?? [])
      .slice()
      .sort((a, b) => a.priceCents - b.priceCents)[0];
    let unit = `🎮 <b>${clip(item.title, 100)}</b>\n`;
    if (!quote) unit += "Prezzo non disponibile.";
    else {
      unit +=
        `<b>${quote.priceCents === 0 ? "GRATIS" : money(quote.priceCents)}</b> · ${clip(quote.shop, 60)}` +
        (quote.cut > 0 ? ` · −${quote.cut}%` : "");
      const url = safeUrl(quote.url);
      if (url && url.length <= 2048 && escapeHtml(url).length <= 2048)
        unit += `\n<a href="${escapeHtml(url)}">Apri offerta</a>`;
      if (quote.expiry !== null)
        unit += `\n⏳ ${formatExpiry(quote.expiry)} (Italia)`;
    }
    const candidate = body + (body ? "\n\n" : "") + unit;
    if (
      header(end + 1).length + candidate.length + footer.length > MAX_TEXT &&
      body
    )
      break;
    body = candidate;
    end++;
  }
  const nextOffset = end < items.length ? end : null;
  const buttons = [];
  if (offset > 0)
    buttons.push({
      text: "◀️ Indietro",
      callback_data: `wishlistpage|${Math.max(0, offset - PAGE_SIZE)}`,
    });
  if (nextOffset !== null)
    buttons.push({
      text: "Avanti ▶️",
      callback_data: `wishlistpage|${nextOffset}`,
    });
  return {
    text: header(end) + body + footer,
    nextOffset,
    ...(buttons.length ? { replyMarkup: { inline_keyboard: [buttons] } } : {}),
  };
}

export async function showWishlist(
  context: ApplicationContext,
  userId: string,
  chatId: string,
  updateId: number,
  offset = 0,
  messageId?: number,
): Promise<void> {
  const items = await context.wishlist.getWishlist(userId);
  offset = pageOffset(items.length, offset);
  const prices = items.length
    ? await context.itad.getPrices(
        items.slice(offset, offset + PAGE_SIZE).map((item) => item.game_id),
      )
    : new Map<string, PriceQuote[]>();
  const page = buildWishlistPage(items, prices, offset);
  const key = `reply:${updateId}:0`;
  if (messageId === undefined)
    await context.deliveries.queueMessage(
      key,
      chatId,
      page.text,
      page.replyMarkup,
    );
  else
    await context.deliveries.queueEdit(
      key,
      chatId,
      messageId,
      page.text,
      updateId,
      page.replyMarkup ?? { inline_keyboard: [] },
    );
}
