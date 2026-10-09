import test from "node:test";
import assert from "node:assert/strict";
import { GgClient } from "../../src/infrastructure/gg/client.js";
import { isKeyBargain, keyDrop } from "../../src/domain/key-pricing.js";
import { ApiError } from "../../src/infrastructure/http.js";
const row = {
  title: "Portal 2",
  url: "https://gg.deals/game/portal-2/",
  prices: {
    currency: "EUR",
    currentRetail: "12.00",
    currentKeyshops: "3.49",
    historicalRetail: "0.00",
    historicalKeyshops: "1.99",
  },
};
test("GG uses the documented endpoint and Italy and normalizes cents without exposing the key", async () => {
  const client = new GgClient("fixture-secret", async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v1/prices/by-steam-app-id/");
    assert.equal(url.searchParams.get("region"), "it");
    assert.equal(url.searchParams.get("ids"), "620");
    return new Response(JSON.stringify({ success: true, data: { 620: row } }));
  });
  const price = (await client.getPrices([620])).get(620)!;
  assert.equal(price!.keyCents, 349);
  assert.equal(price!.retailCents, 1200);
  assert.equal(price!.historicalRetailCents, 0);
});
test("GG rejects incomplete or foreign-currency data instead of fabricating a price", async () => {
  for (const data of [
    {},
    { 620: { ...row, prices: { ...row.prices, currency: "USD" } } },
    { 620: { ...row, prices: { ...row.prices, currentKeyshops: "3.499" } } },
  ]) {
    await assert.rejects(
      new GgClient(
        "fixture",
        async () => new Response(JSON.stringify({ success: true, data })),
      ).getPrices([620]),
      ApiError,
    );
  }
  assert.equal(
    (
      await new GgClient(
        "fixture",
        async () =>
          new Response(JSON.stringify({ success: true, data: { 620: null } })),
      ).getPrices([620])
    ).get(620),
    null,
  );
});
test("GG transport errors cannot leak token URLs", async () => {
  await assert.rejects(
    new GgClient("private-key", async () => {
      throw new Error("https://example.com/?key=private-key");
    }).getPrices([620]),
    (e) => e instanceof ApiError && !e.message.includes("private-key"),
  );
});
test("bargains require both ten euro and fifty percent and reject missing or free retail", () => {
  for (const [key, retail, want] of [
    [1000, 2000, true],
    [1001, 3000, false],
    [999, 1997, false],
    [999, 1998, true],
    [0, 2000, false],
    [500, 0, false],
    [500, null, false],
    [null, 2000, false],
  ] as const)
    assert.equal(isKeyBargain(key, retail), want);
});
test("key references do not notify small subsequent changes or missing data", () => {
  assert.equal(keyDrop(1000, 900, 10), true);
  assert.equal(keyDrop(900, 890, 10), false);
  assert.equal(keyDrop(900, 810, 10), true);
  assert.equal(keyDrop(null, 100, 10), false);
  assert.equal(keyDrop(1000, null, 10), false);
  assert.equal(keyDrop(1000, 0, 10), false);
});
