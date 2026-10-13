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
    `🎁 <b>Gioco gratis da tenere</b>\n\n🎮 <b>${escapeHtml(offer.title.slice(0,200))}</b>` +
    (offer.description ? `\n\n${escapeHtml(offer.description.slice(0,420))}` : "") +
    (offer.genres ? `\n\n🎯 ${escapeHtml(offer.genres.slice(0,100))}` : "") +
    `\n\n🏪 ${escapeHtml(offer.shop.slice(0,60))}\n💰 <b>GRATIS da riscattare</b>` +
    (offer.expiry === null
      ? ""
      : `\n⏳ Scade il ${formatExpiry(offer.expiry)} (Italia)`) +
    `\n\n🔗 <a href="${escapeHtml(offer.url)}">Riscatta il gioco</a>`
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
    `🏪 ${html(quote.shop, 60)} — <b>${price}</b>` +
    (quote.cut > 0 ? ` (-${quote.cut}%)` : "") +
    (url && url.length <= 2048 && escapeHtml(url).length <= 2048
      ? `\n🔗 <a href="${escapeHtml(url)}">Vedi l'offerta</a>`
      : "") +
    (quote.expiry === null
      ? ""
      : `\n⏳ Scade il ${formatExpiry(quote.expiry)} (Italia)`)
  );
}

import type { NewsArticle } from "../domain/news.js";
export function formatNews(article: NewsArticle): string {
  const label={games:"🎮 Videogiochi",cinema:"🎬 Cinema",anime_manga:"🌸 Anime e manga"}[article.topic];
  return `📰 ${label}

<b>${html(article.title,200)}</b>${article.summary?`

${html(article.summary,420)}`:""}

🗞 ${html(article.sourceName,80)} · ${formatExpiry(article.publishedAt)} (Italia)

<a href="${html(article.url,2048)}">Leggi la notizia</a>`;
}
