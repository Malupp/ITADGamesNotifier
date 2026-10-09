import { escapeHtml } from "./formatters.js";
import { toCents } from "../domain/pricing.js";
export const SHOPS: Record<string, number> = {
  fanatical: 6,
  "epic games store": 16,
  epic: 16,
  gamersgate: 24,
  gog: 35,
  greenmangaming: 36,
  "humble store": 37,
  humble: 37,
  indiegala: 42,
  "microsoft store": 48,
  microsoft: 48,
  "ea store": 52,
  ea: 52,
  steam: 61,
  "ubisoft store": 62,
  ubisoft: 62,
  wingamestore: 64,
};
export const SHOP_IDS = [6, 16, 24, 35, 36, 37, 42, 48, 52, 61, 62, 64];
export const PAGE_SIZE = 10;
export const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export const PRIVATE_COMMANDS = new Set([
  "add",
  "remove",
  "wishlist",
  "setsoglia",
  "setsconto",
  "setscontog",
]);
export const COMMANDS = new Set([
  "start",
  "help",
  "deals",
  "cerca",
  "add",
  "remove",
  "wishlist",
  "offerte",
  "offerte_shop",
  "confronta",
  "setsoglia",
  "setsconto",
  "setscontog",
  "status",
]);
export const html = (text: unknown, maximum = 240) =>
  escapeHtml(String(text ?? "").slice(0, maximum));
export const button = (text: string, data: string) => ({
  text: text.slice(0, 60),
  callback_data: data,
});
export const keyboard = (rows: ReturnType<typeof button>[][]) => ({
  inline_keyboard: rows,
});
export const cancel = [button("❌ Annulla", "cancel")];
export const number = (text: string | undefined): number | null =>
  text && /^\d+$/.test(text) ? Number(text) : null;
export const percent = (
  text: string | undefined,
  minimum = 0,
  maximum = 100,
): number | null => {
  const value = number(text);
  return value !== null &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
};
export const priceArg = (text: string | undefined): number | null =>
  text ? toCents(text.replace(",", ".")) : null;
export const best = (quotes: PriceQuote[] | undefined) =>
  quotes?.slice().sort((a, b) => a.priceCents - b.priceCents)[0] ?? null;

import type { PriceQuote } from "../domain/models.js";
