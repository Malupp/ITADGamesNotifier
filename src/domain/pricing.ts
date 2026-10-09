import type { PriceQuote } from "./models.js";
export function toCents(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}
export function effectiveThreshold(value: number | null | undefined): number {
  return Number.isInteger(value) ? Math.max(10, Math.min(99, value!)) : 10;
}
export function isMeaningfulDrop(
  reference: number | null,
  quote: PriceQuote,
  threshold: number,
): boolean {
  return (
    reference !== null &&
    reference > 0 &&
    Number.isSafeInteger(reference) &&
    Number.isSafeInteger(quote.priceCents) &&
    quote.priceCents >= 0 &&
    quote.currency === "EUR" &&
    quote.cut > 0 &&
    quote.regularCents !== null &&
    quote.regularCents > quote.priceCents &&
    quote.priceCents * 100 <= reference * (100 - effectiveThreshold(threshold))
  );
}
