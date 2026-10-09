import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../src/infrastructure/d1/store.js";
import { testDatabase } from "../helpers/sqlite.ts";
import type { PriceQuote } from "../../src/domain/models.js";

const game = { id: "g", slug: "game", title: "Game", type: "game" };
const quote = (cents: number): PriceQuote => ({
  gameId: "g",
  shop: "GOG",
  shopId: 35,
  url: "https://gog.com/game/test",
  priceCents: cents,
  regularCents: 10000,
  cut: 100 - cents / 100,
  currency: "EUR",
  expiry: null,
});

test("missing baseline initializes quietly, then only significant further drops queue", async () => {
  const t = testDatabase();
  const s = new Store(t.db);
  try {
    assert.equal(await s.addWishlist("1", "user", game, null, 1000), true);
    await s.ingestPrices([quote(10000)], 2000);
    assert.equal((await s.pendingDeliveries(2000)).length, 0);
    await s.ingestPrices([quote(9000)], 3000);
    let pending = await s.pendingDeliveries(3000);
    assert.equal(pending.length, 1);
    assert.equal((await s.getWishlist("1"))[0].last_notified_price_cents, null);
    const claimed = await s.claimDelivery(pending[0], 3000);
    assert.ok(claimed);
    await s.completeDelivery(claimed!, 3001);
    await s.ingestPrices([quote(8900)], 4000);
    assert.equal((await s.pendingDeliveries(4000)).length, 0);
    await s.ingestPrices([quote(8100)], 5000);
    pending = await s.pendingDeliveries(5000);
    assert.equal(pending.length, 1);
    assert.equal((await s.getWishlist("1"))[0].last_notified_price_cents, 9000);
  } finally {
    t.close();
  }
});
test("failed send leaves reference unchanged and supports retry after lease expires", async () => {
  const t = testDatabase();
  const s = new Store(t.db);
  try {
    await s.addWishlist("1", null, game, quote(10000), 1000);
    await s.ingestPrices([quote(8000)], 2000);
    const [id] = await s.pendingDeliveries(2000);
    const first = await s.claimDelivery(id, 2000);
    assert.ok(first);
    assert.equal(await s.claimDelivery(id, 2001), null);
    await s.retryDelivery(first!, 5000, "429");
    assert.equal((await s.pendingDeliveries(4999)).length, 0);
    const second = await s.claimDelivery(id, 5000);
    assert.ok(second);
    assert.equal((await s.getWishlist("1"))[0].last_notified_price_cents, null);
    await s.completeDelivery(second!, 5001);
    assert.equal((await s.getWishlist("1"))[0].last_notified_price_cents, 8000);
    assert.equal(await s.claimDelivery(id, 9000), null);
  } finally {
    t.close();
  }
});
test("rebound cancels stale pending alert rather than sending an old discount", async () => {
  const t = testDatabase();
  const s = new Store(t.db);
  try {
    await s.addWishlist("1", null, game, quote(10000), 1000);
    await s.ingestPrices([quote(8000)], 2000);
    const [id] = await s.pendingDeliveries(2000);
    await s.ingestPrices([quote(9500)], 3000);
    assert.equal(await s.claimDelivery(id, 3001), null);
    assert.equal((await s.pendingDeliveries(3001)).length, 0);
  } finally {
    t.close();
  }
});
test("first giveaway page seeds silently; a new campaign on same game can notify once per target", async () => {
  const t = testDatabase();
  const s = new Store(t.db);
  const offer = {
    id: "itad:1:g",
    gameId: "g",
    slug: "game",
    title: "Game",
    shop: "GOG",
    url: "https://gog.com/game/test",
    expiry: 900000,
  };
  try {
    await s.ingestGiveaways([offer], ["1", "2"], 1000, true);
    assert.equal((await s.pendingDeliveries(1000)).length, 0);
    const next = { ...offer, id: "itad:2:g" };
    await s.ingestGiveaways([next], ["1", "2", "1"], 2000, false);
    await s.ingestGiveaways([next], ["1", "2"], 2001, false);
    assert.equal((await s.pendingDeliveries(2001)).length, 2);
  } finally {
    t.close();
  }
});
test("zero user filter stays zero and null per-game threshold inherits user setting", async () => {
  const t = testDatabase();
  const s = new Store(t.db);
  try {
    await s.setPrefs("1", null, { minCut: 0, minScore: 0, minDiscountPct: 20 });
    assert.deepEqual(await s.getPrefs("1"), {
      thresholdCents: 500,
      minCut: 0,
      minScore: 0,
      minDiscountPct: 20,
    });
    await s.addWishlist("1", null, game, quote(10000), 1000);
    await s.ingestPrices([quote(8500)], 2000);
    assert.equal((await s.pendingDeliveries(2000)).length, 0);
    await s.setWishlistDiscount("1", "g", 10);
    await s.ingestPrices([quote(8500)], 3000);
    assert.equal((await s.pendingDeliveries(3000)).length, 1);
  } finally {
    t.close();
  }
});
test("expired and abandoned delivery can be recreated at the same still-valid price", async () => {
  const t = testDatabase(),
    s = new Store(t.db);
  try {
    await s.addWishlist("1", null, game, quote(10000), 1000);
    await s.ingestPrices([quote(8000)], 2000);
    const [id] = await s.pendingDeliveries(2000);
    assert.ok(await s.claimDelivery(id, 2000)); // crash before recording delivery
    await s.cancelInvalidPending(2000000);
    await s.ingestPrices([quote(8000)], 2000001);
    assert.equal((await s.pendingDeliveries(2000001)).length, 1);
    assert.ok(await s.claimDelivery(id, 2000001));
  } finally {
    t.close();
  }
});

test("Free capacity allows shared games but refuses the201st distinct game", async () => {
  const t = testDatabase(),
    s = new Store(t.db);
  try {
    for (let i = 0; i < 200; i++)
      assert.equal(
        await s.addWishlist(
          "1",
          null,
          { ...game, id: "g" + i },
          null,
          1000 + i,
        ),
        true,
      );
    assert.equal(
      await s.addWishlist("1", null, { ...game, id: "overflow" }, null, 3000),
      false,
    );
    assert.equal(
      await s.addWishlist("2", null, { ...game, id: "g0" }, null, 3000),
      true,
    );
    assert.equal((await s.gameIds()).length, 200);
  } finally {
    t.close();
  }
});
