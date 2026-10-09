import { effectiveThreshold } from "./pricing.js";
export interface GgPrices {
  appId: number;
  title: string;
  url: string;
  keyCents: number | null;
  retailCents: number | null;
  historicalKeyCents: number | null;
  historicalRetailCents: number | null;
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
