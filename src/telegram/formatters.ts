import type { Offer, PriceQuote } from "../domain/models.js";
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
const romeTime = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  dateStyle: "short",
  timeStyle: "short",
});
export function formatExpiry(value: number | null): string {
  return value === null ? "" : romeTime.format(value);
}
export function money(cents: number): string {
  return `€${(cents / 100).toFixed(2).replace(".", ",")}`;
}

export function formatGiveaway(offer: Offer): string {
  return (
    `🎮 <b>${escapeHtml(offer.title)}</b>\n🏪 ${escapeHtml(offer.shop)}\n💰 <b>GRATIS da riscattare</b>` +
    (offer.expiry === null
      ? ""
      : `\n⏳ Scade il ${formatExpiry(offer.expiry)} (Italia)`) +
    `\n🔗 <a href="${escapeHtml(offer.url)}">Riscatta il gioco</a>`
  );
}
export function formatPrice(title: string, quote: PriceQuote): string {
  return `🔔 <b>Ribasso wishlist</b>\n🎮 <b>${escapeHtml(title)}</b>\n🏪 ${escapeHtml(quote.shop)}\n💰 <b>${money(quote.priceCents)}</b>\n🔗 <a href="${escapeHtml(quote.url)}">Vedi l'offerta</a>`;
}

import { safeUrl } from "../domain/urls.js";
const html = (text: unknown, maximum = 240) =>
  escapeHtml(String(text ?? "").slice(0, maximum));
export function quoteText(quote: PriceQuote): string {
  const url = safeUrl(quote.url);
  const price = quote.priceCents === 0 ? "GRATIS" : money(quote.priceCents);
  return (
    `🏪 ${html(quote.shop, 100)} — <b>${price}</b>` +
    (quote.cut > 0 ? ` (-${quote.cut}%)` : "") +
    (url && url.length <= 2048
      ? `\n🔗 <a href="${escapeHtml(url)}">Vedi l'offerta</a>`
      : "") +
    (quote.expiry === null
      ? ""
      : `\n⏳ Scade il ${formatExpiry(quote.expiry)} (Italia)`)
  );
}
