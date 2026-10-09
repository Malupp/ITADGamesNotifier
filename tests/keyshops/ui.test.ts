import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/sqlite.js";
import { createContext } from "../../src/application/context.js";
import { handleUpdate } from "../../src/application/update.js";
const game = {
  id: "018d937f-07fc-72ed-8517-000000000001",
  title: "Portal",
  slug: "portal",
  type: "game",
  steamAppId: 620,
};
const key = {
  appId: 620,
  title: "Portal",
  url: "https://gg.deals/game/portal/?ref=source",
  keyCents: 400,
  retailCents: 2000,
  historicalKeyCents: 200,
  historicalRetailCents: 0,
};
function setup() {
  const t = testDatabase();
  const c = createContext(
    {
      DB: t.db,
      KEYSHOPS_ENABLED: "true",
      GGDEALS_API_KEY: "fixture",
      ITAD_API_KEY: "fixture",
      TELEGRAM_BOT_TOKEN: "fixture",
    } as any,
    { now: () => 60000, recordTiming: () => {} },
  );
  c.itad.searchGames = async () => [game];
  c.itad.getGameInfo = async () => game;
  c.itad.getPrices = async () =>
    new Map([
      [
        game.id,
        [
          {
            gameId: game.id,
            shop: "Steam",
            shopId: 61,
            url: "https://store.steampowered.com/app/620",
            priceCents: 2000,
            regularCents: 4000,
            cut: 50,
            currency: "EUR",
            expiry: null,
          },
        ],
      ],
    ]);
  c.gg.getPrices = async () => new Map([[620, key]]);
  return { t, c };
}
for (const cmd of ["/confronta Portal", "/wishlist", "/keys"])
  test(`${cmd} retains one message with attributed key prices`, async () => {
    const { t, c } = setup();
    await c.wishlist.addWishlist("7", null, game, null, 1);
    await c.keys.map(game.id, game.title, 620, 1);
    await c.keys.selectPool([game], 1);
    await c.keys.observe(game.id, key, 2000, 60000, true, []);
    await handleUpdate(c, {
      update_id: 1,
      message: {
        message_id: 1,
        text: cmd,
        from: { id: 7 },
        chat: { id: 7, type: "private" },
      },
    });
    const rows = t.sqlite.prepare("SELECT * FROM deliveries").all() as any[];
    assert.equal(rows.length, 1);
    assert.match(rows[0].text, /GG.deals/);
    assert.match(rows[0].text, /4,00/);
    assert.match(rows[0].text, /ref=source/);
    assert.ok(rows[0].text.length <= 3800);
    t.close();
  });
test("GG failures still show authorized price and no invented merchant data", async () => {
  const { t, c } = setup();
  c.gg.getPrices = async () => {
    throw new Error("unavailable");
  };
  await handleUpdate(c, {
    update_id: 1,
    message: {
      message_id: 1,
      text: "/confronta Portal",
      from: { id: 7 },
      chat: { id: 7, type: "private" },
    },
  });
  const row = t.sqlite.prepare("SELECT text FROM deliveries").get()!;
  assert.match(String(row.text), /Steam/);
  assert.doesNotMatch(String(row.text), /Instant Gaming/);
  t.close();
});
test("interactive refresh compares against current authorized prices, including zero", async () => {
  const { t, c } = setup();
  await c.keys.map(game.id, game.title, 620, 1);
  await c.keys.selectPool([game], 1);
  await c.keys.observe(game.id, key, 0, -2000000, true, []);
  c.itad.getPrices = async () =>
    new Map([
      [
        game.id,
        [
          {
            gameId: game.id,
            shop: "Steam",
            shopId: 61,
            url: "https://store.steampowered.com/app/620",
            priceCents: 0,
            regularCents: 2000,
            cut: 100,
            currency: "EUR",
            expiry: null,
          },
        ],
      ],
    ]);
  await handleUpdate(c, {
    update_id: 1,
    message: {
      message_id: 1,
      text: "/wishlist",
      from: { id: 7 },
      chat: { id: 7, type: "private" },
    },
  });
  await handleUpdate(c, {
    update_id: 2,
    message: {
      message_id: 2,
      text: "/confronta Portal",
      from: { id: 7 },
      chat: { id: 7, type: "private" },
    },
  });
  assert.equal((await c.keys.bargains(60000)).length, 0);
  t.close();
});
test("wishlist key reply expires with the oldest displayed key observation", async () => {
  const { t, c } = setup();
  await c.wishlist.addWishlist("7", null, game, null, 1);
  await c.keys.map(game.id, game.title, 620, 1);
  await c.keys.observe(game.id, key, 2000, 60000, true, []);
  await handleUpdate(c, {
    update_id: 1,
    message: {
      message_id: 1,
      text: "/wishlist",
      from: { id: 7 },
      chat: { id: 7, type: "private" },
    },
  });
  assert.equal(
    t.sqlite.prepare("SELECT expires_at FROM deliveries").get()!.expires_at,
    3660000,
  );
  t.close();
});
test("fresh key cache incorporates a new authorized zero price without renewing key freshness", async () => {
  const { t, c } = setup();
  await c.keys.map(game.id, game.title, 620, 1);
  await c.keys.selectPool([game], 1);
  await c.keys.observe(game.id, key, 2000, 60000, true, []);
  c.itad.getPrices = async () =>
    new Map([
      [
        game.id,
        [
          {
            gameId: game.id,
            shop: "Steam",
            shopId: 61,
            url: "https://store.steampowered.com/app/620",
            priceCents: 0,
            regularCents: 2000,
            cut: 100,
            currency: "EUR",
            expiry: null,
          },
        ],
      ],
    ]);
  await handleUpdate(c, {
    update_id: 1,
    message: {
      message_id: 1,
      text: "/confronta Portal",
      from: { id: 7 },
      chat: { id: 7, type: "private" },
    },
  });
  assert.equal((await c.keys.bargains(60000)).length, 0);
  assert.equal(
    (await c.keys.prices([game.id])).get(game.id)!.observedAt,
    60000,
  );
  t.close();
});
test('offers paginate valid long authorized and GG links without splitting HTML',async()=>{
 const {t,c}=setup();const url='https://gg.deals/game/portal/?ref='+ 'x'.repeat(1900);const p={...key,url};await c.keys.map(game.id,game.title,620,1);await c.keys.observe(game.id,p,2000,60000,true,[]);
 c.itad.getDeals=async()=>[{game,steamScore:null,quote:{gameId:game.id,shop:'Steam',shopId:61,url:'https://store.steampowered.com/app/620?ref='+ 'x'.repeat(1890),priceCents:2000,regularCents:4000,cut:50,currency:'EUR',expiry:null}}];
 await handleUpdate(c,{update_id:1,message:{message_id:1,text:'/offerte 50',from:{id:7},chat:{id:7,type:'private'}}});const rows=t.sqlite.prepare('SELECT text FROM deliveries').all();assert.equal(rows.length,1);assert.ok(String(rows[0].text).length<=3800);assert.match(String(rows[0].text),/Pagina 1 di 2/);t.close();
});
