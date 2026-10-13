import { enrollPrivateUsers } from "../helpers/notifications.js";
import test from "node:test";
import assert from "node:assert/strict";
import { isSpecialKeyDeal, bestRegular } from "../../src/domain/key-pricing.js";
import { testDatabase } from "../helpers/sqlite.js";
import { KeysRepository } from "../../src/infrastructure/d1/keys.js";
import { DeliveriesRepository } from "../../src/infrastructure/d1/deliveries.js";
import { createContext } from "../../src/application/context.js";
import { revalidateKeyDelivery } from "../../src/application/keys.js";
const p = {
  appId: 620,
  title: "Gioco",
  url: "https://gg.deals/game/example/",
  keyCents: 2500,
  retailCents: 4000,
  regularCents: 6000,
  historicalKeyCents: null,
  historicalRetailCents: null,
};
test("special deals require list strictly above30 EUR, at least50% cut and a cheaper key than retail", () => {
  for (const [key, regular, retail, want] of [
    [2500, 6000, 4000, true],
    [3000, 6000, 4000, true],
    [3001, 6000, 4000, false],
    [1500, 3000, 2500, false],
    [1500, 3001, 2500, true],
    [1000, null, 4000, false],
    [1000, 6000, 0, false],
    [2500, 6000, 2000, false],
    [2500, 6000, 2500, false],
    [0, 6000, 4000, false],
  ] as const)
    assert.equal(isSpecialKeyDeal(key, regular, retail), want);
  assert.equal(
    bestRegular([
      { shopId: 61, regularCents: 6000, priceCents: 4000 },
      { shopId: 6, regularCents: 5000, priceCents: 3000 },
    ]),
    6000,
  );
  assert.equal(
    bestRegular([
      { shopId: 6, regularCents: 5000, priceCents: 3000 },
      { shopId: 35, regularCents: 4000, priceCents: 3000 },
    ]),
    4000,
  );
  assert.equal(
    bestRegular([{ shopId: 61, regularCents: 2000, priceCents: 3000 }]),
    null,
  );
});
test("only qualifying2026/2027 general alerts are queued and outbox invalidates a changed list", async (t) => {
  const d = testDatabase();
  t.after(d.close);
  await enrollPrivateUsers(d.db,["9"],0,true);
  const keys = new KeysRepository(d.db),
    out = new DeliveriesRepository(d.db);
  for (const [id, year, regular, key] of [
    ["current", 2026, 6000, 2500],
    ["next", 2027, 6000, 2500],
    ["old", 2025, 6000, 2500],
    ["cheap", 2026, 3000, 1000],
    ["unknown", 2026, null, 1000],
    ["smallcut", 2026, 6000, 3100],
  ] as const) {
    await keys.map(id, id, 620, 1, year);
    await keys.observe(
      id,
      { ...p, regularCents: regular, keyCents: key },
      4000,
      1,
      false,
      ["9"],
    );
  }
  assert.deepEqual(
    d.sqlite
      .prepare(
        "SELECT game_id FROM deliveries WHERE source='keydeal' AND status='pending' ORDER BY game_id",
      )
      .all()
      .map((x) => x.game_id),
    ["current", "next"],
  );
  await keys.observe(
    "current",
    { ...p, regularCents: 3000 },
    4000,
    2,
    true,
    [],
    true,
  );
  await out.cancelInvalidPending(2);
  assert.deepEqual(
    d.sqlite
      .prepare(
        "SELECT game_id FROM deliveries WHERE source='keydeal' AND status='pending'",
      )
      .all()
      .map((x) => x.game_id),
    ["next"],
  );
});
test("delivery fetches official list again and refuses missing, cheap, or insufficient-discount regular prices", async (t) => {
  for (const [regular, want] of [
    [6000, true],
    [3000, false],
    [null, false],
    [4900, false],
  ] as const) {
    const d = testDatabase();
    t.after(d.close);
    await enrollPrivateUsers(d.db,["9"],0,true);
    const c = createContext(
      {
        DB: d.db,
        KEYSHOPS_ENABLED: "true",
        GGDEALS_API_KEY: "fixture",
        ITAD_API_KEY: "fixture",
        TELEGRAM_BOT_TOKEN: "fixture",
        TELEGRAM_WEBHOOK_SECRET: "fixture",
        TELEGRAM_CHAT_ID: "9",
        WORK_QUEUE: {} as any,
      },
      { recordTiming: () => {} },
    );
    await c.keys.map("g", "Gioco", 620, 1, 2026);
    await c.keys.observe("g", p, 4000, 2, false, ["9"]);
    const [id] = await c.deliveries.pendingDeliveries(2);
    assert.ok(id);
    const delivery = (await c.deliveries.claimDelivery(id, 2))!;
    c.gg.getPrices = async () => new Map([[620, p]]);
    c.itad.getPrices = async () =>
      new Map([
        [
          "g",
          [
            {
              gameId: "g",
              shop: "Steam",
              shopId: 61,
              url: "https://store.steampowered.com/app/620/",
              priceCents: 4000,
              regularCents: regular,
              cut: 0,
              currency: "EUR",
              expiry: null,
            },
          ],
        ],
      ]);
    const result = await revalidateKeyDelivery(c, delivery, 3);
    assert.equal(result !== null, want);
    if (result) assert.match(result, /Listino.*60/);
  }
});
test("official price refresh preserves the valid list rather than deleting it", async (t) => {
  const d = testDatabase();
  t.after(d.close);
  await enrollPrivateUsers(d.db,["9"],0,true);
  const keys = new KeysRepository(d.db);
  await keys.map("g", "Gioco", 620, 1, 2026);
  await keys.observe("g", p, 4000, 1, true, []);
  await keys.compareRetail(
    new Map([["g", [{ shopId: 61, priceCents: 4000, regularCents: 6000 }]]]),
  );
  assert.equal((await keys.prices(["g"])).get("g")?.regularCents, 6000);
});
