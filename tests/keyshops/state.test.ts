import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/sqlite.js";
import { KeysRepository } from "../../src/infrastructure/d1/keys.js";
import { WishlistRepository } from "../../src/infrastructure/d1/wishlist.js";
import { DeliveriesRepository } from "../../src/infrastructure/d1/deliveries.js";
const game = { id: "game", title: "Portal", slug: "portal", type: "game" };
const price = {
  appId: 620,
  title: "Portal",
  url: "https://gg.deals/game/portal/",
  keyCents: 1000,
  retailCents: 3000,
  historicalKeyCents: 100,
  historicalRetailCents: 0,
};
test("shared budget atomically enforces minute and hour limits including retries", async () => {
  const t = testDatabase();
  const r = new KeysRepository(t.db);
  const at = 3600000;
  await r.reserve(100, at);
  await assert.rejects(r.reserve(1, at), /429/);
  for (let i = 1; i < 9; i++) await r.reserve(100, at + i * 60000);
  await assert.rejects(r.reserve(1, at + 9 * 60000), /429/);
  await r.reserve(100, at + 3600000);
  t.close();
});
test("key baseline is quiet, independent, and advances only on confirmed delivery; re-add seeds again", async () => {
  const t = testDatabase(),
    r = new KeysRepository(t.db),
    w = new WishlistRepository(t.db),
    d = new DeliveriesRepository(t.db);
  await w.addWishlist("user", null, game, null, 1);
  await r.map(game.id, game.title, 620, 1);
  await r.observe(game.id, price, 3000, 1, false, ["channel"]);
  assert.equal((await d.pendingDeliveries(1)).length, 1); // new general bargain; wishlist quiet
  await r.observe(game.id, { ...price, keyCents: 950 }, 3000, 2, false, []);
  assert.equal(
    t.sqlite
      .prepare("SELECT COUNT(*) n FROM deliveries WHERE source='keyshop'")
      .get()!.n,
    0,
  );
  await r.observe(game.id, { ...price, keyCents: 900 }, 3000, 3, false, []);
  const id = (await d.pendingDeliveries(3)).find((x) =>
    x.startsWith("keyshop"),
  )!;
  const claimed = await d.claimDelivery(id, 3);
  assert.ok(claimed);
  assert.equal(
    t.sqlite
      .prepare("SELECT notified FROM key_alert_state WHERE mode='wishlist'")
      .get()!.notified,
    null,
  );
  await d.completeDelivery(claimed, 4);
  assert.equal(
    t.sqlite
      .prepare("SELECT notified FROM key_alert_state WHERE mode='wishlist'")
      .get()!.notified,
    900,
  );
  assert.equal(
    t.sqlite.prepare("SELECT last_notified_price_cents FROM wishlist").get()!
      .last_notified_price_cents,
    null,
  );
  await w.removeWishlist("user", game.id);
  await w.addWishlist("user", null, game, null, 5);
  await r.observe(game.id, { ...price, keyCents: 700 }, 3000, 6, false, []);
  assert.equal(
    t.sqlite
      .prepare("SELECT baseline FROM key_alert_state WHERE mode='wishlist'")
      .get()!.baseline,
    700,
  );
  t.close();
});
test("quiet discovery, real comparisons, rebound and changed preferences invalidate pending keys", async () => {
  const t = testDatabase(),
    r = new KeysRepository(t.db),
    w = new WishlistRepository(t.db),
    d = new DeliveriesRepository(t.db);
  await w.addWishlist("u", null, game, null, 1);
  await r.map(game.id, game.title, 620, 1);
  await r.observe(game.id, price, 3000, 1, true, ["channel"]);
  assert.deepEqual(await d.pendingDeliveries(1), []);
  await r.observe(game.id, { ...price, keyCents: 800 }, 3000, 2, false, [
    "channel",
  ]);
  assert.equal((await d.pendingDeliveries(2)).length, 2);
  await w.setWishlistDiscount("u", game.id, 30);
  await d.cancelInvalidPending(2);
  assert.equal(
    t.sqlite
      .prepare("SELECT status FROM deliveries WHERE source='keyshop'")
      .get()!.status,
    "expired",
  );
  await r.observe(game.id, { ...price, keyCents: 950 }, 0, 3, false, [
    "channel",
  ]);
  await d.cancelInvalidPending(3);
  assert.equal(
    t.sqlite
      .prepare("SELECT status FROM deliveries WHERE source='keydeal'")
      .get()!.status,
    "expired",
  );
  t.close();
});
test("new general bargain stays eligible through a changed price before its first successful alert", async () => {
  const t = testDatabase(),
    r = new KeysRepository(t.db),
    d = new DeliveriesRepository(t.db);
  await r.map(game.id, game.title, 620, 1);
  await r.observe(game.id, { ...price, keyCents: 1500 }, 3000, 1, true, [
    "channel",
  ]);
  await r.observe(game.id, { ...price, keyCents: 800 }, 3000, 2, false, [
    "channel",
  ]);
  await r.observe(game.id, { ...price, keyCents: 850 }, 3000, 3, false, [
    "channel",
  ]);
  await d.cancelInvalidPending(3);
  await r.observe(game.id, { ...price, keyCents: 850 }, 3000, 4, false, [
    "channel",
  ]);
  const pending = await d.pendingDeliveries(4);
  assert.equal(pending.length, 1);
  assert.ok(await d.claimDelivery(pending[0], 4));
  t.close();
});
test("an old processing key delivery cannot advance a re-added wishlist generation", async () => {
  const t = testDatabase(),
    r = new KeysRepository(t.db),
    w = new WishlistRepository(t.db),
    d = new DeliveriesRepository(t.db);
  await w.addWishlist("u", null, game, null, 1);
  await r.map(game.id, game.title, 620, 1);
  await r.observe(game.id, price, 3000, 1, true, []);
  await r.observe(game.id, { ...price, keyCents: 800 }, 3000, 2, false, []);
  const old = (await d.claimDelivery((await d.pendingDeliveries(2))[0], 2))!;
  await w.removeWishlist("u", game.id);
  await w.addWishlist("u", null, game, null, 3);
  await r.observe(game.id, { ...price, keyCents: 700 }, 3000, 4, true, []);
  await d.completeDelivery(old, 5);
  assert.equal(
    t.sqlite
      .prepare("SELECT notified FROM key_alert_state WHERE mode='wishlist'")
      .get()!.notified,
    null,
  );
  t.close();
});
test("twenty games and two destinations use a bounded number of D1 statements", async () => {
  const t = testDatabase();
  let queries = 0;
  const db = {
    ...t.db,
    prepare: (sql: string) => {
      queries++;
      return t.db.prepare(sql);
    },
  } as D1Database;
  const r = new KeysRepository(db);
  await r.observeMany(
    Array.from({ length: 20 }, (_, n) => ({
      id: "g" + n,
      price: { ...price, appId: n + 1 },
      retail: 3000,
    })),
    1,
    true,
    ["channel", "group"],
  );
  assert.ok(queries <= 10, `queries: ${queries}`);
  t.close();
});
test("retired mapping cannot complete into a new app baseline", async () => {
  const t = testDatabase(),
    r = new KeysRepository(t.db),
    w = new WishlistRepository(t.db),
    d = new DeliveriesRepository(t.db);
  await w.addWishlist("u", null, game, null, 1);
  await r.map(game.id, game.title, 620, 1);
  await r.observe(game.id, price, 3000, 1, true, []);
  await r.observe(game.id, { ...price, keyCents: 800 }, 3000, 2, false, []);
  const old = (await d.claimDelivery((await d.pendingDeliveries(2))[0], 2))!;
  await r.map(game.id, game.title, 621, 3);
  await r.observe(
    game.id,
    { ...price, appId: 621, keyCents: 700 },
    3000,
    4,
    true,
    [],
  );
  await d.completeDelivery(old, 5);
  assert.equal(
    t.sqlite
      .prepare("SELECT notified FROM key_alert_state WHERE mode='wishlist'")
      .get()!.notified,
    null,
  );
  t.close();
});
test("same-price delivery after mapping change keeps the new app identity", async () => {
  const t = testDatabase(),
    r = new KeysRepository(t.db),
    d = new DeliveriesRepository(t.db);
  await r.map(game.id, game.title, 620, 1);
  await r.observe(game.id, { ...price, keyCents: 800 }, 3000, 1, false, [
    "channel",
  ]);
  await r.map(game.id, game.title, 621, 2);
  await r.observe(
    game.id,
    { ...price, appId: 621, keyCents: 800 },
    3000,
    3,
    false,
    ["channel"],
  );
  await d.cancelInvalidPending(3);
  const pending = await d.pendingDeliveries(3);
  assert.equal(pending.length, 1);
  const claimed = await d.claimDelivery(pending[0], 3);
  assert.equal(claimed?.key_app_id, 621);
  t.close();
});
