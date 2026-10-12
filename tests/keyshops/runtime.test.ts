import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/sqlite.js";
import { createContext } from "../../src/application/context.js";
import {
  scheduleKeys,
  processKeyScan,
  revalidateKeyDelivery,
} from "../../src/application/keys.js";
const game = {
  id: "game",
  title: "Portal",
  slug: "portal",
  type: "game",
  steamAppId: 620,
  releaseYear: 2026,
};
const p = {
  appId: 620,
  title: "Portal",
  url: "https://gg.deals/game/portal/",
  keyCents: 1000,
  retailCents: 3000,
  regularCents: 6000,
  historicalKeyCents: 100,
  historicalRetailCents: 0,
};
function setup() {
  const t = testDatabase();
  const published: any[] = [];
  const c = createContext(
    {
      DB: t.db,
      SCANS_ENABLED: "true",
      KEYSHOPS_ENABLED: "true",
      GGDEALS_API_KEY: "private",
      ITAD_API_KEY: "private",
      TELEGRAM_BOT_TOKEN: "private",
      TELEGRAM_WEBHOOK_SECRET: "private",
      TELEGRAM_CHAT_ID: "channel",
      WORK_QUEUE: {
        sendBatch: async (items: any[]) => {
          published.push(...items.map((x) => x.body));
        },
      } as any,
    },
    { recordTiming: () => {} },
  );
  c.itad.getPopularGames = async () => [game];
  c.itad.getDeals = async () => [];
  c.itad.getGameInfo = async () => game;
  c.itad.getPrices = async () => new Map();
  c.gg.getPrices = async () => new Map([[620, p]]);
  return { t, c, published };
}
test("scheduled GG prices without a list field persist the official ITAD list", async () => {
  const { t, c, published } = setup();
  try {
    const { regularCents: _ignored, ...raw } = p;
    c.gg.getPrices = async () => new Map([[620, raw]]);
    c.itad.getPrices = async () =>
      new Map([
        [
          game.id,
          [
            {
              gameId: game.id,
              shop: "Steam",
              shopId: 61,
              url: "https://store.steampowered.com/app/620/",
              priceCents: 3000,
              regularCents: 6000,
              cut: 50,
              currency: "EUR",
              expiry: null,
            },
          ],
        ],
      ]);
    await scheduleKeys(c, 60000);
    while (published.length) {
      const job = published.shift();
      if (job.kind === "keyscan") await processKeyScan(job.id, c, 60000);
    }
    assert.equal(
      (await c.keys.prices([game.id])).get(game.id)?.regularCents,
      6000,
    );
  } finally {
    t.close();
  }
});
test("durable discovery/map/price chain recovers lost publication and seeds quietly", async () => {
  const { t, c, published } = setup();
  await c.wishlist.addWishlist("u", null, game, null, 1);
  await scheduleKeys(c, 60000);
  let item = published.shift();
  assert.equal(item.kind, "keyscan");
  await processKeyScan(item.id, c, 60000);
  let next = published.shift();
  assert.ok(next);
  await processKeyScan(item.id, c, 60000);
  assert.ok(published.some((x) => x.id === next.id));
  published.length = 0;
  await processKeyScan(next.id, c, 60000);
  next = published.shift();
  await processKeyScan(next.id, c, 60000);
  assert.equal(await c.settings.getSetting("keys_seeded"), "true");
  assert.equal((await c.keys.mapping(game.id))?.releaseYear, 2026);
  assert.deepEqual(await c.deliveries.pendingDeliveries(60000), []);
  assert.equal((await c.keys.prices(["game"])).get("game")!.keyCents, 1000);
  t.close();
});
test("source failures and rebound prevent sending and do not advance references", async () => {
  const { t, c } = setup();
  await c.wishlist.addWishlist("u", null, game, null, 1);
  await c.keys.map(game.id, game.title, 620, 1);
  await c.keys.observe(game.id, p, 3000, 1, true, []);
  await c.keys.observe(game.id, { ...p, keyCents: 800 }, 3000, 2, false, []);
  const id = (await c.deliveries.pendingDeliveries(2))[0];
  const d = (await c.deliveries.claimDelivery(id, 2))!;
  c.gg.getPrices = async () => {
    throw new Error("unavailable");
  };
  await assert.rejects(revalidateKeyDelivery(c, d, 3));
  assert.equal(
    t.sqlite.prepare("SELECT notified FROM key_alert_state").get()!.notified,
    null,
  );
  c.gg.getPrices = async () => new Map([[620, { ...p, keyCents: 950 }]]);
  assert.equal(await revalidateKeyDelivery(c, d, 4), null);
  t.close();
});
