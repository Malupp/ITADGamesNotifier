import assert from "node:assert/strict";
import test from "node:test";
import { ItadClient } from "../../src/infrastructure/itad/client.js";
import { ApiError } from "../../src/infrastructure/http.js";

const games = Array.from({ length: 12 }, (_, n) => ({
  id: `018d937f-07fc-72ed-8517-${String(n).padStart(12, "0")}`,
  title: `Game ${n}`,
  slug: `game-${n}`,
  type: "game",
  deal: {
    shop: { id: 61, name: "Steam" },
    url: "https://example.com/game",
    price: { amountInt: 500, currency: "EUR" },
    regular: { amountInt: 1000, currency: "EUR" },
    cut: 50,
    expiry: null,
  },
}));
function transport(fail = false) {
  let active = 0,
    peak = 0,
    requests = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/deals/v2")
      return new Response(JSON.stringify({ list: games, hasMore: false }));
    assert.equal(url.pathname, "/games/info/v2");
    requests++;
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    if (fail)
      return new Response("{}", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    return new Response(
      JSON.stringify({ reviews: [{ source: "Steam", score: 80 }] }),
    );
  };
  return { fetcher, counts: () => ({ peak, requests }) };
}

test("two review requests overlap with the same ranking and no unnecessary requests for the limit", async () => {
  const parallel = transport(),
    serial = transport();
  const options = { maxPriceCents: 1000, minScore: 70, limit: 3 };
  const a = await new ItadClient("fixture", parallel.fetcher, {
    reviewConcurrency: 2,
  }).getDeals(options);
  const b = await new ItadClient("fixture", serial.fetcher, {
    reviewConcurrency: 1,
  }).getDeals(options);
  assert.deepEqual(
    a.map((x) => x.game.title),
    ["Game 0", "Game 1", "Game 2"],
  );
  assert.deepEqual(a, b);
  assert.deepEqual(parallel.counts(), { peak: 2, requests: 3 });
  assert.deepEqual(serial.counts(), { peak: 1, requests: 3 });
});
test("review concurrency never exceeds two or ten total requests", async () => {
  const h = transport();
  const deals = await new ItadClient("fixture", h.fetcher, {
    reviewConcurrency: 2,
  }).getDeals({ maxPriceCents: 1000, minScore: 70, limit: 30 });
  assert.equal(deals.length, 10);
  assert.deepEqual(h.counts(), { peak: 2, requests: 10 });
});
test("a review rate limit rejects the operation without returning partial deals", async () => {
  const h = transport(true);
  await assert.rejects(
    () =>
      new ItadClient("fixture", h.fetcher, { reviewConcurrency: 2 }).getDeals({
        maxPriceCents: 1000,
        minScore: 70,
        limit: 3,
      }),
    (error) =>
      error instanceof ApiError &&
      error.status === 429 &&
      error.retryAfter === 60,
  );
  assert.ok(h.counts().requests <= 2);
});
