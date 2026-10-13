import { enrollPrivateUsers } from "../helpers/notifications.js";
import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/sqlite.js";
import { KeysRepository } from "../../src/infrastructure/d1/keys.js";
import { WishlistRepository } from "../../src/infrastructure/d1/wishlist.js";
import { DeliveriesRepository } from "../../src/infrastructure/d1/deliveries.js";
import { ItadClient } from "../../src/infrastructure/itad/client.js";
import { createContext } from "../../src/application/context.js";
import { scheduleKeys, processKeyScan, revalidateKeyDelivery } from "../../src/application/keys.js";

const game = {
  id: "018d937f-07fc-72ed-8517-d8e24cb1eb22",
  title: "Example",
  slug: "example",
  type: "game",
};
const price = {
  appId: 620,
  title: game.title,
  url: "https://gg.deals/game/example/",
  keyCents: 800,
  retailCents: 3000,
  regularCents: 6000,
  historicalKeyCents: 100,
  historicalRetailCents: 0,
};

test("ITAD extracts the release year only from a valid calendar date", async () => {
  for (const [releaseDate, want] of [
    ["2026-01-01", 2026], ["2027-12-31", 2027], ["2025-12-31", 2025],
    [null, null], [undefined, null], ["TBA", null], ["2026-02-30", null],
    ["2026-13-01", null], ["2026", null], [2026, null],
  ] as const) {
    const client = new ItadClient("fixture", async () => new Response(JSON.stringify({ ...game, appid: 620, releaseDate })));
    assert.equal((await client.getGameInfo(game.id))?.releaseYear ?? null, want, String(releaseDate));
  }
});

test("general key alerts include only 2026 and 2027 while wishlist drops keep all years", async () => {
  const t = testDatabase();
  await enrollPrivateUsers(t.db,["9"],0,true);
  try {
    const keys = new KeysRepository(t.db), wishlist = new WishlistRepository(t.db);
    for (const [id, year] of [["recent", 2026], ["next", 2027], ["old", 2025], ["future", 2028], ["unknown", null]] as const) {
      await wishlist.addWishlist("user", null, { ...game, id }, null, 1);
      await keys.map(id, id, 620, 1, year);
      await keys.observe(id, { ...price, keyCents: 1500 }, 3000, 1, true, ["9"]);
      await keys.observe(id, price, 3000, 2, false, ["9"]);
    }
    const alerts = t.sqlite.prepare("SELECT source,game_id FROM deliveries WHERE status='pending' ORDER BY game_id").all();
    assert.deepEqual(alerts.filter(r => r.source === "keydeal").map(r => r.game_id), ["next", "recent"]);
    assert.deepEqual(alerts.filter(r => r.source === "keyshop").map(r => r.game_id), ["future", "next", "old", "recent", "unknown"]);
  } finally {
    t.close();
  }
});

test("pending general key alerts expire when release metadata changes or becomes unknown", async () => {
  for (const year of [2025, 2028, null]) {
    const t = testDatabase();
    await enrollPrivateUsers(t.db,["9"],0,true);
    try {
      const keys = new KeysRepository(t.db), deliveries = new DeliveriesRepository(t.db);
      await keys.map(game.id, game.title, 620, 1, 2026);
      await keys.observe(game.id, price, 3000, 1, false, ["9"]);
      assert.equal((await deliveries.pendingDeliveries(1)).length, 1);
      await keys.map(game.id, game.title, 620, 2, year);
      await deliveries.cancelInvalidPending(2);
      assert.deepEqual(await deliveries.pendingDeliveries(2), []);
    } finally {
      t.close();
    }
  }
});

test("delivery revalidation refreshes release metadata and rejects excluded years", async () => {
  for (const [year, want] of [[2026, true], [2027, true], [2025, false], [2028, false], [null, false]] as const) {
    const t = testDatabase();
    await enrollPrivateUsers(t.db,["9"],0,true);
    try {
      const c = createContext(
        {
          DB: t.db,
          KEYSHOPS_ENABLED: "true",
          GGDEALS_API_KEY: "fixture",
          ITAD_API_KEY: "fixture",
          TELEGRAM_BOT_TOKEN: "fixture",
          TELEGRAM_WEBHOOK_SECRET: "fixture",
          TELEGRAM_CHAT_ID: "9",
          WORK_QUEUE: { sendBatch: async () => {} } as any,
        },
        { recordTiming: () => {} },
      );
      await c.keys.map(game.id, game.title, 620, 1, 2026);
      await c.keys.observe(game.id, price, 3000, 1, false, ["9"]);
      const d = (await c.deliveries.claimDelivery((await c.deliveries.pendingDeliveries(1))[0], 1))!;
      c.itad.getGameInfo = async () => ({ ...game, steamAppId: 620, releaseYear: year });
      c.gg.getPrices = async () => new Map([[620, price]]);
      c.itad.getPrices = async () => new Map([[game.id,[{gameId:game.id,shop:"Steam",shopId:61,url:"https://store.steampowered.com/app/620/",priceCents:3000,regularCents:6000,cut:50,currency:"EUR",expiry:null}]]]);
      assert.equal((await revalidateKeyDelivery(c, d, 8 * 86400000)) !== null, want, String(year));
    } finally {
      t.close();
    }
  }
});

// An old Worker can write a fresh mapping between the schema migration and deploy.
test("a fresh legacy mapping still loads release metadata on the first new scan", async () => {
  const t = testDatabase();
  await enrollPrivateUsers(t.db,["9"],0,true);
  try {
    const jobs: any[] = [];
    const c = createContext(
      {
        DB: t.db,
        SCANS_ENABLED: "true",
        KEYSHOPS_ENABLED: "true",
        GGDEALS_API_KEY: "fixture",
        ITAD_API_KEY: "fixture",
        TELEGRAM_BOT_TOKEN: "fixture",
        TELEGRAM_WEBHOOK_SECRET: "fixture",
        TELEGRAM_CHAT_ID: "9",
        WORK_QUEUE: {
          sendBatch: async (items: any[]) => {
            jobs.push(...items.map(x => x.body));
          },
        } as any,
      },
      { recordTiming: () => {} },
    );
    await c.keys.selectPool([game], 100000);
    t.sqlite.prepare("UPDATE key_games SET steam_app_id=620,mapped_at=100000 WHERE game_id=?").run(game.id);
    c.itad.getGameInfo = async () => ({ ...game, steamAppId: 620, releaseYear: 2026 });
    c.itad.getPrices = async () => new Map();
    c.gg.getPrices = async () => new Map([[620, price]]);
    await scheduleKeys(c, 100001);
    while (jobs.length) {
      const job = jobs.shift();
      await processKeyScan(job.id, c, 100001);
    }
    assert.equal((await c.keys.mapping(game.id))?.releaseYear, 2026);
  } finally {
    t.close();
  }
});
