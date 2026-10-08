import type { Game, PriceQuote } from './types.js';

export class ApiError extends Error {
  constructor(public status: number, public retryAfter?: number, public permanent = false) {
    super(`API request failed (${status})`); this.name = 'ApiError';
  }
}
export interface DealOptions { maxPriceCents: number; minPriceCents?: number; minCut?: number; minScore?: number; shopIds?: number[]; limit?: number }
export interface DealResult { game: Game; quote: PriceQuote; steamScore: number | null }

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const boundedLimit = (limit: number, maximum: number) => Number.isSafeInteger(limit) ? Math.max(1, Math.min(maximum, limit)) : maximum;

function gameFrom(value: unknown): Game | null {
  const data = record(value);
  return uuid(data.id) && data.type === 'game' && typeof data.title === 'string' && data.title.length > 0 && typeof data.slug === 'string'
    ? { id: data.id, slug: data.slug, title: data.title, type: data.type } : null;
}
function cents(value: unknown): number | null {
  const data = record(value);
  if (data.currency !== 'EUR') return null;
  if (positiveInt(data.amountInt)) return data.amountInt;
  if (typeof data.amount !== 'number' || !Number.isFinite(data.amount) || data.amount < 0) return null;
  const result = Math.round(data.amount * 100);
  return Number.isSafeInteger(result) ? result : null;
}
function quoteFrom(gameId: string, value: unknown): PriceQuote | null {
  const data = record(value), shop = record(data.shop);
  const priceCents = cents(data.price);
  let url: URL;
  try { url = new URL(data.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || priceCents === null || !positiveInt(shop.id) || typeof shop.name !== 'string') return null;
  const expiry = data.expiry === null || data.expiry === undefined ? null : typeof data.expiry === 'string' ? Date.parse(data.expiry) : NaN;
  if (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now())) return null;
  if (typeof data.cut !== 'number' || !Number.isFinite(data.cut) || data.cut < 0 || data.cut > 100) return null;
  return { gameId, shop: shop.name, shopId: shop.id, url: data.url, priceCents,
    regularCents: cents(data.regular), cut: data.cut, currency: 'EUR', expiry };
}
async function request(fetcher: typeof fetch, url: string | URL, init: RequestInit, telegram = false): Promise<unknown> {
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(10_000) });
    let data: any;
    try { data = await response.json(); }
    catch { throw new ApiError(response.ok ? 502 : response.status, undefined, telegram && (response.status === 400 || response.status === 403)); }
    if (!response.ok || (telegram && record(data).ok !== true)) {
      const status = telegram && positiveInt(record(data).error_code) ? data.error_code : response.status;
      const retry = record(record(data).parameters).retry_after ?? Number(response.headers.get('Retry-After'));
      throw new ApiError(status, positiveInt(retry) && retry > 0 ? retry : undefined, telegram && (status === 400 || status === 403));
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Fetch errors may contain credentials, request URLs or response bodies.
    throw new ApiError(0);
  }
}

/** API contract: https://docs.isthereanydeal.com/ */
export class ItadClient {
  constructor(private apiKey: string, private fetcher: typeof fetch = fetch) {}
  private call(path: string, params: Record<string, string>, body?: unknown) {
    const url = new URL(path, 'https://api.isthereanydeal.com');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return request(this.fetcher, url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'ITAD-API-Key': this.apiKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async searchGames(query: string, limit = 5): Promise<Game[]> {
    const data = await this.call('/games/search/v1', { title: query, results: String(boundedLimit(limit, 10)) });
    if (!Array.isArray(data)) throw new ApiError(502);
    return data.map(gameFrom).filter((game): game is Game => game !== null).slice(0, boundedLimit(limit, 10));
  }
  async getGameInfo(id: string): Promise<Game | null> {
    if (!uuid(id)) return null;
    try { return gameFrom(await this.call('/games/info/v2', { id })); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  }
  async getPrices(ids: string[]): Promise<Map<string, PriceQuote[]>> {
    const result = new Map<string, PriceQuote[]>();
    const unique = [...new Set(ids)].filter(uuid);
    for (let offset = 0; offset < unique.length; offset += 10) {
      const batch = unique.slice(offset, offset + 10);
      const data = await this.call('/games/prices/v3', { country: 'IT', vouchers: 'false' }, batch);
      if (!Array.isArray(data)) throw new ApiError(502);
      for (const value of data) {
        const item = record(value);
        if (!batch.includes(item.id)) continue;
        if (!Array.isArray(item.deals)) throw new ApiError(502);
        result.set(item.id, item.deals.map((deal: unknown) => quoteFrom(item.id, deal)).filter((quote: PriceQuote | null): quote is PriceQuote => quote !== null));
      }
    }
    return result;
  }
  async getGiveaways(offset = 0, limit = 10): Promise<{items: unknown[]; hasMore: boolean}> {
    const size = boundedLimit(limit, 10);
    const data = await this.call('/giveaways/v1', { offset: String(positiveInt(offset) ? offset : 0), limit: String(size), expired: 'false', mature: 'true' });
    if (!Array.isArray(data)) throw new ApiError(502);
    return { items: data, hasMore: data.length >= size };
  }
  async getDeals(options: DealOptions): Promise<DealResult[]> {
    const limit = boundedLimit(options.limit ?? 10, 30);
    const params: Record<string, string> = { country: 'IT', limit: '200', sort: 'rank', nondeals: 'false', mature: 'true' };
    if (options.shopIds?.length) params.shops = options.shopIds.join(',');
    const data = record(await this.call('/deals/v2', params));
    if (!Array.isArray(data.list)) throw new ApiError(502);
    const result: DealResult[] = [];
    let infoRequests = 0;
    for (const value of data.list) {
      const item = record(value), game = gameFrom(item);
      if (!game) continue;
      const quote = quoteFrom(game.id, item.deal);
      if (!quote || quote.priceCents <= 0 || quote.priceCents < (options.minPriceCents ?? 0) || quote.priceCents > options.maxPriceCents || quote.cut < (options.minCut ?? 0)) continue;
      if (options.shopIds?.length && !options.shopIds.includes(quote.shopId)) continue;
      let steamScore: number | null = null;
      // Reviews are documented on game info, not on the deals list.
      if ((options.minScore ?? 0) > 0) {
        if (infoRequests++ >= 10) break;
        const info = record(await this.call('/games/info/v2', { id: game.id }));
        const steam = Array.isArray(info.reviews) ? info.reviews.find((review: any) => record(review).source === 'Steam') : null;
        steamScore = typeof steam?.score === 'number' && Number.isFinite(steam.score) ? steam.score : null;
        if (steamScore === null || steamScore < (options.minScore ?? 0)) continue;
      }
      result.push({ game, quote, steamScore });
      if (result.length >= limit) break;
    }
    return result;
  }
}
/** API contract: https://core.telegram.org/bots/api */
export class TelegramClient {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  private async call(method: string, body: Record<string, unknown>): Promise<void> {
    await request(this.fetcher, `https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, true);
  }
  async sendMessage(chatId: string, text: string, replyMarkup?: unknown): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }) });
  }
  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, ...(text === undefined ? {} : { text }) });
  }
}
