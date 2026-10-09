import { ApiError, request } from "../http.js";
import { toCents } from "../../domain/pricing.js";
import type { GgPrices } from "../../domain/key-pricing.js";
import { escapeHtml } from "../../telegram/formatters.js";

/** https://gg.deals/api/prices/ — personal/hobby access with attribution. */
export class GgClient {
  constructor(
    private key: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async getPrices(ids: number[]): Promise<Map<number, GgPrices | null>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    if (
      unique.length > 100 ||
      unique.some((id) => !Number.isSafeInteger(id) || id <= 0)
    )
      throw new ApiError(400);
    const url = new URL("https://api.gg.deals/v1/prices/by-steam-app-id/");
    url.search = new URLSearchParams({
      key: this.key,
      ids: unique.join(","),
      region: "it",
    }).toString();
    const data: any = await request(this.fetcher, url, { method: "GET" });
    if (data?.success !== true || !data.data || typeof data.data !== "object")
      throw new ApiError(502);
    const result = new Map<number, GgPrices | null>();
    for (const appId of unique) {
      const row = data.data[appId];
      if (row === null) {
        result.set(appId, null);
        continue;
      }
      if (
        !row ||
        typeof row.title !== "string" ||
        !row.title.length ||
        row.prices?.currency !== "EUR"
      )
        throw new ApiError(502);
      let parsed: URL;
      try {
        parsed = new URL(row.url);
      } catch {
        throw new ApiError(502);
      }
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== "gg.deals" ||
        parsed.username ||
        parsed.password ||
        escapeHtml(parsed.href).length > 2048 ||
        !parsed.pathname.startsWith("/game/")
      )
        throw new ApiError(502);
      const cents = (value: unknown) => {
        if (value === null) return null;
        if (typeof value !== "string" || toCents(value) === null)
          throw new ApiError(502);
        return toCents(value);
      };
      result.set(appId, {
        appId,
        title: Array.from(row.title).slice(0, 100).join(""),
        url: parsed.href,
        keyCents: cents(row.prices.currentKeyshops),
        retailCents: cents(row.prices.currentRetail),
        historicalKeyCents: cents(row.prices.historicalKeyshops),
        historicalRetailCents: cents(row.prices.historicalRetail),
      });
    }
    return result;
  }
}
