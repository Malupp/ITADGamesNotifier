import type { Game, PriceQuote } from "../../domain/models.js";
import { ApiError, request } from "../http.js";
export interface DealOptions {
  maxPriceCents: number;
  minPriceCents?: number;
  minCut?: number;
  minScore?: number;
  shopIds?: number[];
  limit?: number;
}
export interface DealResult {
  game: Game;
  quote: PriceQuote;
  steamScore: number | null;
}

const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const positiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const boundedLimit = (limit: number, maximum: number) =>
  Number.isSafeInteger(limit) ? Math.max(1, Math.min(maximum, limit)) : maximum;

function gameFrom(value: unknown): Game | null {
  const data = record(value);
  return uuid(data.id) &&
    data.type === "game" &&
    typeof data.title === "string" &&
    data.title.length > 0 &&
    typeof data.slug === "string"
    ? {
        id: data.id,
        slug: data.slug,
        title: data.title,
        type: data.type,
        ...("appid" in data
          ? {
              steamAppId:
                positiveInt(data.appid) && data.appid > 0 ? data.appid : null,
            }
          : {}),
      }
    : null;
}
function cents(value: unknown): number | null {
  const data = record(value);
  if (data.currency !== "EUR") return null;
  if (positiveInt(data.amountInt)) return data.amountInt;
  if (
    typeof data.amount !== "number" ||
    !Number.isFinite(data.amount) ||
    data.amount < 0
  )
    return null;
  const result = Math.round(data.amount * 100);
  return Number.isSafeInteger(result) ? result : null;
}
function quoteFrom(gameId: string, value: unknown): PriceQuote | null {
  const data = record(value),
    shop = record(data.shop);
  const priceCents = cents(data.price);
  let url: URL;
  try {
    url = new URL(data.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    priceCents === null ||
    !positiveInt(shop.id) ||
    typeof shop.name !== "string"
  )
    return null;
  const expiry =
    data.expiry === null || data.expiry === undefined
      ? null
      : typeof data.expiry === "string"
        ? Date.parse(data.expiry)
        : NaN;
  if (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now()))
    return null;
  if (
    typeof data.cut !== "number" ||
    !Number.isFinite(data.cut) ||
    data.cut < 0 ||
    data.cut > 100
  )
    return null;
  return {
    gameId,
    shop: shop.name,
    shopId: shop.id,
    url: data.url,
    priceCents,
    regularCents: cents(data.regular),
    cut: data.cut,
    currency: "EUR",
    expiry,
  };
}
/** API contract: https://docs.isthereanydeal.com/ */
export class ItadClient {
  constructor(
    private apiKey: string,
    private fetcher: typeof fetch = fetch,
    private options: {
      reviewConcurrency?: 1 | 2;
      measureRequest?: <T>(action: () => Promise<T>) => Promise<T>;
    } = {},
  ) {}
  private call(path: string, params: Record<string, string>, body?: unknown) {
    const url = new URL(path, "https://api.isthereanydeal.com");
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    const action = () =>
      request(this.fetcher, url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "ITAD-API-Key": this.apiKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return this.options.measureRequest
      ? this.options.measureRequest(action)
      : action();
  }
  async searchGames(query: string, limit = 5): Promise<Game[]> {
    const data = await this.call("/games/search/v1", {
      title: query,
      results: String(boundedLimit(limit, 10)),
    });
    if (!Array.isArray(data)) throw new ApiError(502);
    return data
      .map(gameFrom)
      .filter((game): game is Game => game !== null)
      .slice(0, boundedLimit(limit, 10));
  }
  async getGameInfo(id: string): Promise<Game | null> {
    if (!uuid(id)) return null;
    try {
      return gameFrom(await this.call("/games/info/v2", { id }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
  async getPopularGames(limit = 100): Promise<Game[]> {
    const data = await this.call("/stats/most-popular/v1", {
      limit: String(boundedLimit(limit, 100)),
    });
    if (!Array.isArray(data)) throw new ApiError(502);
    return data
      .map(gameFrom)
      .filter((game): game is Game => game !== null)
      .slice(0, limit);
  }
  async getPrices(ids: string[]): Promise<Map<string, PriceQuote[]>> {
    const result = new Map<string, PriceQuote[]>();
    const unique = [...new Set(ids)].filter(uuid);
    for (let offset = 0; offset < unique.length; offset += 10) {
      const batch = unique.slice(offset, offset + 10);
      const data = await this.call(
        "/games/prices/v3",
        { country: "IT", vouchers: "false" },
        batch,
      );
      if (!Array.isArray(data)) throw new ApiError(502);
      for (const value of data) {
        const item = record(value);
        if (!batch.includes(item.id)) continue;
        if (!Array.isArray(item.deals)) throw new ApiError(502);
        result.set(
          item.id,
          item.deals
            .map((deal: unknown) => quoteFrom(item.id, deal))
            .filter(
              (quote: PriceQuote | null): quote is PriceQuote => quote !== null,
            ),
        );
      }
    }
    return result;
  }
  async getGiveaways(
    offset = 0,
    limit = 10,
  ): Promise<{ items: unknown[]; hasMore: boolean }> {
    const size = boundedLimit(limit, 10);
    const data = await this.call("/giveaways/v1", {
      offset: String(positiveInt(offset) ? offset : 0),
      limit: String(size),
      expired: "false",
      mature: "true",
    });
    if (!Array.isArray(data)) throw new ApiError(502);
    return { items: data, hasMore: data.length >= size };
  }
  async getDeals(options: DealOptions): Promise<DealResult[]> {
    const limit = boundedLimit(options.limit ?? 10, 30);
    const params: Record<string, string> = {
      country: "IT",
      limit: "200",
      sort: "rank",
      nondeals: "false",
      mature: "true",
    };
    if (options.shopIds?.length) params.shops = options.shopIds.join(",");
    const data = record(await this.call("/deals/v2", params));
    if (!Array.isArray(data.list)) throw new ApiError(502);
    const candidates: DealResult[] = [];
    for (const value of data.list) {
      const item = record(value),
        game = gameFrom(item);
      if (!game) continue;
      const quote = quoteFrom(game.id, item.deal);
      if (
        !quote ||
        quote.priceCents <= 0 ||
        quote.priceCents < (options.minPriceCents ?? 0) ||
        quote.priceCents > options.maxPriceCents ||
        quote.cut < (options.minCut ?? 0)
      )
        continue;
      if (options.shopIds?.length && !options.shopIds.includes(quote.shopId))
        continue;
      candidates.push({ game, quote, steamScore: null });
    }
    if ((options.minScore ?? 0) <= 0) return candidates.slice(0, limit);
    const result: DealResult[] = [];
    const concurrency = this.options.reviewConcurrency === 2 ? 2 : 1;
    for (
      let offset = 0;
      offset < Math.min(candidates.length, 10) && result.length < limit;

    ) {
      const size = Math.min(concurrency, limit - result.length, 10 - offset);
      const batch = candidates.slice(offset, offset + size);
      offset += batch.length;
      const reviewed = await Promise.all(
        batch.map(async (candidate) => {
          const info = record(
            await this.call("/games/info/v2", { id: candidate.game.id }),
          );
          const steam = Array.isArray(info.reviews)
            ? info.reviews.find((r: any) => record(r).source === "Steam")
            : null;
          const score =
            typeof steam?.score === "number" && Number.isFinite(steam.score)
              ? steam.score
              : null;
          return { ...candidate, steamScore: score };
        }),
      );
      for (const candidate of reviewed)
        if (
          candidate.steamScore !== null &&
          candidate.steamScore >= (options.minScore ?? 0)
        )
          result.push(candidate);
    }
    return result;
  }
}
