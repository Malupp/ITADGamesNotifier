import { cpuUsage } from "node:process";
import { ItadClient } from "../../src/infrastructure/itad/client.js";
import {
  escapeHtml,
  formatExpiry,
  formatGiveaway,
  formatPrice,
  money,
} from "../../src/telegram/formatters.js";
import { isMeaningfulDrop } from "../../src/domain/pricing.js";
import { normalizeGiveaways } from "../../src/domain/promotions.js";

// Synthetic local Node measurements only. They do not measure Cloudflare billing,
// isolate startup, live API latency, D1 access, Queue execution or delivery work.
const INVOCATIONS = 100;
const WARMUP = 25;
const now = Date.now();
const expiry = new Date(now + 86_400_000).toISOString();
const game = (index: number) => ({
  id: `018d937f-07fc-72ed-8517-${index.toString(16).padStart(12, "0")}`,
  slug: `synthetic-pc-game-${index}`,
  title: `Synthetic PC game ${index} & edition`,
  type: "game",
  mature: false,
  assets: {},
});
const amount = (cents: number) => ({
  amount: cents / 100,
  amountInt: cents,
  currency: "EUR",
});
const quote = (priceCents: number, shopId = 61) => ({
  shop: {
    id: shopId,
    name: shopId === 61 ? "Steam" : shopId === 35 ? "GOG" : "Fanatical",
  },
  price: amount(priceCents),
  regular: amount(3999),
  cut: Math.floor(((3999 - priceCents) * 100) / 3999),
  voucher: null,
  storeLow: amount(priceCents),
  historyLow: amount(priceCents),
  drm: [{ id: 61, name: "Steam" }],
  platforms: [{ id: 1, name: "Windows" }],
  timestamp: new Date(now).toISOString(),
  expiry,
  url: "https://example.com/synthetic-offer?edition=1&region=IT",
});
const giveaways = Array.from({ length: 10 }, (_, index) => ({
  id: 90000 + index,
  title: `${game(index).title} — giveaway`,
  shop: { id: 35, name: "GOG" },
  url: "https://example.com/synthetic-giveaway",
  details: "https://example.com/synthetic-details",
  isMature: false,
  publish: new Date(now).toISOString(),
  expiry: index === 9 ? new Date(now - 1000).toISOString() : expiry,
  note: index === 8 ? "Requires subscription" : null,
  games: [
    {
      ...game(index),
      type: index === 6 || index === 7 ? "dlc" : "game",
      drmFree: true,
      keys: [{ id: 35, name: "GOG" }],
      platforms: [{ id: 1, name: "Windows" }],
    },
  ],
}));
const pricePayload = JSON.stringify(
  Array.from({ length: 10 }, (_, index) => ({
    id: game(index).id,
    historyLow: { all: amount(999), y1: amount(999), m3: amount(1499) },
    deals:
      index === 8
        ? []
        : [quote(index === 9 ? 0 : 1999), quote(2299, 35), quote(1899, 6)],
  })),
);
const dealsPayload = JSON.stringify({
  hasMore: false,
  nextOffset: 200,
  list: Array.from({ length: 200 }, (_, index) => ({
    ...game(index),
    deal: quote(index < 190 ? 4500 : 699 + (index - 190) * 100),
  })),
});
const jsonResponse = (body: string) =>
  new Response(body, { headers: { "Content-Type": "application/json" } });

type Counts = Record<string, number>;
type Scenario = {
  name: string;
  expected: Counts;
  run: () => Promise<Counts> | Counts;
};
const scenarios: Scenario[] = [
  {
    name: "giveaways10-normalize-render",
    expected: { sourceRecords: 10, eligibleOffers: 6, renderedMessages: 6 },
    run() {
      const offers = normalizeGiveaways(giveaways, now);
      const rendered = offers.map(formatGiveaway);
      if (rendered.some((text) => text.length === 0))
        throw new Error("Synthetic giveaway rendering failed");
      return {
        sourceRecords: giveaways.length,
        eligibleOffers: offers.length,
        renderedMessages: rendered.length,
      };
    },
  },
  {
    name: "prices10-parse-evaluate-render",
    expected: { games: 10, quotes: 27, eligibleAlerts: 9, syntheticFetches: 1 },
    async run() {
      let syntheticFetches = 0;
      const client = new ItadClient(
        "synthetic-api-key",
        async (input, init) => {
          if (
            new URL(String(input)).pathname !== "/games/prices/v3" ||
            JSON.parse(String(init?.body)).length !== 10
          )
            throw new Error("Unexpected synthetic price request");
          syntheticFetches++;
          return jsonResponse(pricePayload);
        },
      );
      const prices = await client.getPrices(
        Array.from({ length: 10 }, (_, index) => game(index).id),
      );
      let quotes = 0,
        eligibleAlerts = 0;
      for (const [id, available] of prices) {
        quotes += available.length;
        const best = available
          .slice()
          .sort((a, b) => a.priceCents - b.priceCents)[0];
        if (best && isMeaningfulDrop(2500, best, 10)) {
          const text = formatPrice(
            `Synthetic game ${id.slice(-2)} & edition`,
            best,
          );
          if (!text.length) throw new Error("Synthetic price rendering failed");
          eligibleAlerts++;
        }
      }
      return { games: prices.size, quotes, eligibleAlerts, syntheticFetches };
    },
  },
  {
    name: "command200-deals-filter-review-render",
    expected: {
      sourceRecords: 200,
      filteredDeals: 10,
      renderedMessages: 10,
      syntheticFetches: 11,
    },
    async run() {
      let syntheticFetches = 0;
      const client = new ItadClient("synthetic-api-key", async (input) => {
        syntheticFetches++;
        const url = new URL(String(input));
        if (url.pathname === "/deals/v2") return jsonResponse(dealsPayload);
        if (url.pathname === "/games/info/v2")
          return jsonResponse(
            JSON.stringify({
              ...game(190),
              id: url.searchParams.get("id"),
              appid: 100001,
              reviews: [
                {
                  source: "Steam",
                  score: 80,
                  count: 1500,
                  url: "https://example.com/synthetic-reviews",
                },
              ],
            }),
          );
        throw new Error("Unexpected synthetic deal request");
      });
      const deals = await client.getDeals({
        maxPriceCents: 2000,
        minCut: 10,
        minScore: 70,
        limit: 10,
        shopIds: [61],
      });
      const rendered = deals.map(
        ({ game, quote, steamScore }) =>
          `🎮 <b>${escapeHtml(game.title)}</b>\n🏪 ${escapeHtml(quote.shop)} — <b>${money(quote.priceCents)}</b>` +
          ` (-${quote.cut}%)\n🔗 <a href="${escapeHtml(quote.url)}">Vedi l'offerta</a>` +
          `\n⏳ Scade il ${formatExpiry(quote.expiry)} (Italia)\n⭐ Review Steam: ${steamScore}%`,
      );
      if (rendered.some((text) => text.length === 0))
        throw new Error("Synthetic command rendering failed");
      return {
        sourceRecords: 200,
        filteredDeals: deals.length,
        renderedMessages: rendered.length,
        syntheticFetches,
      };
    },
  },
];

const rounded = (milliseconds: number) => Number(milliseconds.toFixed(3));
const results = [];
for (const scenario of scenarios) {
  const check = (actual: Counts) => {
    if (
      Object.entries(scenario.expected).some(
        ([key, value]) => actual[key] !== value,
      )
    )
      throw new Error(
        `Synthetic scenario ${scenario.name} produced unexpected counts`,
      );
  };
  for (let index = 0; index < WARMUP; index++) check(await scenario.run());
  const samples: number[] = [];
  const wallSamples: number[] = [];
  for (let index = 0; index < INVOCATIONS; index++) {
    const wallStart = performance.now();
    const start = cpuUsage();
    const counts = await scenario.run();
    const used = cpuUsage(start);
    wallSamples.push(performance.now() - wallStart);
    samples.push((used.user + used.system) / 1000);
    check(counts);
  }
  samples.sort((a, b) => a - b);
  wallSamples.sort((a, b) => a - b);
  // Windows CPU counters can report zero for short operations, then a coarse
  // quantum on a later invocation. Wall timing exposes that a zero CPU sample
  // does not establish zero execution cost; neither metric proves Free fit.
  results.push({
    scenario: scenario.name,
    syntheticCounts: scenario.expected,
    warmupInvocations: WARMUP,
    measuredInvocations: INVOCATIONS,
    zeroCpuSamples: samples.filter((sample) => sample === 0).length,
    localNodeCpuMs: {
      mean: rounded(
        samples.reduce((total, sample) => total + sample, 0) / samples.length,
      ),
      p50: rounded(samples[Math.ceil(samples.length * 0.5) - 1]),
      p95: rounded(samples[Math.ceil(samples.length * 0.95) - 1]),
      maximum: rounded(samples[samples.length - 1]),
    },
    localNodeWallMs: {
      p50: rounded(wallSamples[Math.ceil(wallSamples.length * 0.5) - 1]),
      p95: rounded(wallSamples[Math.ceil(wallSamples.length * 0.95) - 1]),
      maximum: rounded(wallSamples[wallSamples.length - 1]),
    },
  });
}
console.log(JSON.stringify({ results }, null, 2));
