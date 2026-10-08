import type { Offer, PriceQuote } from './types.ts';

export function toCents(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}
export function effectiveThreshold(value: number | null | undefined): number {
  return Number.isInteger(value) ? Math.max(10, Math.min(99, value!)) : 10;
}
export function isMeaningfulDrop(reference: number | null, quote: PriceQuote, threshold: number): boolean {
  return reference !== null && reference > 0 && Number.isSafeInteger(reference) &&
    Number.isSafeInteger(quote.priceCents) && quote.priceCents >= 0 && quote.currency === 'EUR' &&
    quote.cut > 0 && quote.regularCents !== null && quote.regularCents > quote.priceCents &&
    quote.priceCents * 100 <= reference * (100 - effectiveThreshold(threshold));
}
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
const romeTime = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' });
export function formatExpiry(value: number | null): string {
  return value === null ? '' : romeTime.format(value);
}
export function money(cents: number): string { return `€${(cents / 100).toFixed(2).replace('.', ',')}`; }

export function normalizeGiveaways(raw: unknown[], now: number): Offer[] {
  const offers = new Map<string, Offer>();
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, any>;
    if (!Number.isSafeInteger(item.id) || !item.shop || typeof item.shop.name !== 'string') continue;
    if (/\b(prime|subscription|game\s?pass|playstation\s?plus)\b/i.test(item.shop.name)) continue;
    // Unknown prerequisites are not evidence that an Italian user can claim it.
    if (item.note != null && (typeof item.note !== 'string' || (item.note.trim() && item.note.trim() !== '* Giveaway previously offered.'))) continue;
    if (/\b(mobile|android|ios|demo|trial|weekend|dlc|f2p|subscription|prime)\b/i.test(String(item.title ?? ''))) continue;
    const url = safeUrl(item.url);
    if (!url) continue;
    const expiry = item.expiry == null ? null : Date.parse(item.expiry);
    if (expiry !== null && (!Number.isFinite(expiry) || expiry <= now)) continue;
    if (!Array.isArray(item.games)) continue;
    for (const game of item.games) {
      if (!game || game.type !== 'game' || typeof game.id !== 'string' || typeof game.slug !== 'string' || typeof game.title !== 'string') continue;
      if (!Array.isArray(game.platforms) || !game.platforms.some((p: any) => p && [1, 2, 3].includes(p.id))) continue;
      const id = `itad:${item.id}:${game.id}`;
      offers.set(id, { id, gameId: game.id, slug: game.slug, title: game.title, shop: item.shop.name, url, expiry });
    }
  }
  return [...offers.values()];
}
export function formatGiveaway(offer: Offer): string {
  return `🎮 <b>${escapeHtml(offer.title)}</b>\n🏪 ${escapeHtml(offer.shop)}\n💰 <b>GRATIS da riscattare</b>` +
    (offer.expiry === null ? '' : `\n⏳ Scade il ${formatExpiry(offer.expiry)} (Italia)`) +
    `\n🔗 <a href="${escapeHtml(offer.url)}">Riscatta il gioco</a>`;
}
export function formatPrice(title: string, quote: PriceQuote): string {
  return `🔔 <b>Ribasso wishlist</b>\n🎮 <b>${escapeHtml(title)}</b>\n🏪 ${escapeHtml(quote.shop)}\n💰 <b>${money(quote.priceCents)}</b>\n🔗 <a href="${escapeHtml(quote.url)}">Vedi l'offerta</a>`;
}
