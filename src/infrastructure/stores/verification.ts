import { ApiError } from "../http.js";
import type { Offer, PriceQuote } from "../../domain/models.js";
// A campaign alone is insufficient: require an actual 100% EUR sale in IT
// from the same store. Permanent F2P (regular=0), unknown stores and currencies fail closed.
const shopKey = (name: string) =>
  /epic/i.test(name)
    ? "epic"
    : name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .replace(/store$/, "");
export function verifyGiveaways(
  offers: Offer[],
  prices: Map<string, PriceQuote[]>,
): Offer[] {
  return offers.filter((o) =>
    (prices.get(o.gameId) ?? []).some(
      (q) =>
        q.priceCents === 0 &&
        q.currency === "EUR" &&
        q.cut === 100 &&
        q.regularCents !== null &&
        q.regularCents > 0 &&
        shopKey(q.shop) === shopKey(o.shop),
    ),
  );
}

export async function confirmOfficialGiveaways(
  offers: Offer[],
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Offer[]> {
  const verified: Offer[] = [];
  let epic: any;
  if (offers.some((o) => shopKey(o.shop) === "epic")) {
    epic = await officialJson(
      "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=it&country=IT&allowCountries=IT",
      fetcher,
    );
    if (!Array.isArray(epic?.data?.Catalog?.searchStore?.elements))
      throw new ApiError(502);
  }
  for (const o of offers) {
    const url = new URL(o.url);
    if (shopKey(o.shop) === "epic" && url.hostname === "store.epicgames.com") {
      const slug = url.pathname.match(
        /^\/(?:(?:[a-z]{2}(?:-[A-Za-z]{2})?)\/)?p\/([^/]+)\/?$/,
      )?.[1];
      if (!slug) continue;
      const game = epic.data.Catalog.searchStore.elements.find(
        (g: any) =>
          g.offerType === "BASE_GAME" &&
          (g.catalogNs?.mappings ?? []).some((m: any) => m.pageSlug === slug),
      );
      const price = game?.price?.totalPrice;
      const promo = game?.promotions?.promotionalOffers
        ?.flatMap((p: any) => p.promotionalOffers ?? [])
        .find(
          (p: any) =>
            p.discountSetting?.discountPercentage === 0 &&
            Date.parse(p.startDate) <= now &&
            Date.parse(p.endDate) > now,
        );
      if (
        price?.currencyCode === "EUR" &&
        price.discountPrice === 0 &&
        price.originalPrice > 0 &&
        promo
      )
        verified.push({
          ...o,
          expiry: Math.min(o.expiry ?? Infinity, Date.parse(promo.endDate)),
        });
    } else if (
      shopKey(o.shop) === "steam" &&
      url.hostname === "store.steampowered.com"
    ) {
      const appid = url.pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1];
      if (!appid) continue;
      const result = await officialJson(
        "https://store.steampowered.com/api/appdetails?appids=" +
          appid +
          "&cc=IT&l=italian",
        fetcher,
      );
      const data = result?.[appid]?.data;
      if (
        result?.[appid]?.success &&
        data?.type === "game" &&
        data.is_free === false &&
        data.price_overview?.currency === "EUR" &&
        data.price_overview.final === 0 &&
        data.price_overview.initial > 0 &&
        data.price_overview.discount_percent === 100
      )
        verified.push(o);
    }
  }
  return verified;
}

async function officialJson(url: string, fetcher: typeof fetch): Promise<any> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new ApiError(response.status);
    const text = await response.text();
    if (text.length > 256000) throw new ApiError(502);
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(502);
  }
}
