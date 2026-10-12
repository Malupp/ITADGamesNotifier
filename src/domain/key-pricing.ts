import { effectiveThreshold } from "./pricing.js";
export interface GgPrices {
  /** Enriched by the application from ITAD; absent in the raw GG response. */
  regularCents?: number | null;
  appId: number;
  title: string;
  url: string;
  keyCents: number | null;
  retailCents: number | null;
  historicalKeyCents: number | null;
  historicalRetailCents: number | null;
}
export function isSpecialKeyDeal(
  key: number | null,
  regular: number | null,
  retail: number | null,
): boolean {
  return (
    key !== null &&
    regular !== null &&
    retail !== null &&
    [key, regular, retail].every(Number.isSafeInteger) &&
    key > 0 &&
    regular > 3000 &&
    key * 2 <= regular &&
    key < retail
  );
}
/** Steam list price first; otherwise the lowest valid official list. */
export function bestRegular(
  quotes: Array<{
    shopId: number;
    regularCents: number | null;
    priceCents: number;
  }>,
): number | null {
  const valid = quotes.filter(
    (q) =>
      q.regularCents !== null &&
      Number.isSafeInteger(q.regularCents) &&
      q.regularCents > 0 &&
      q.regularCents >= q.priceCents,
  );
  return (
    valid.find((q) => q.shopId === 61)?.regularCents ??
    (valid.length ? Math.min(...valid.map((q) => q.regularCents!)) : null)
  );
}
export function isKeyBargain(
  key: number | null,
  retail: number | null,
): boolean {
  return (
    key !== null &&
    retail !== null &&
    Number.isSafeInteger(key) &&
    Number.isSafeInteger(retail) &&
    key > 0 &&
    key <= 1000 &&
    retail > 0 &&
    key * 2 <= retail
  );
}
export function keyDrop(
  reference: number | null,
  price: number | null,
  threshold: number,
): boolean {
  return (
    reference !== null &&
    price !== null &&
    reference > 0 &&
    price > 0 &&
    Number.isSafeInteger(reference) &&
    Number.isSafeInteger(price) &&
    price * 100 <= reference * (100 - effectiveThreshold(threshold))
  );
}
export function bestRetail(
  ...values: Array<number | null | undefined>
): number | null {
  const valid = values.filter(
    (v): v is number => v != null && Number.isSafeInteger(v) && v >= 0,
  );
  return valid.length ? Math.min(...valid) : null;
}
