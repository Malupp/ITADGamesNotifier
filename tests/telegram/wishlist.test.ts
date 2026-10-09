import assert from "node:assert/strict";
import test from "node:test";
import { createContext } from "../../src/application/context.js";
import { handleUpdate } from "../../src/application/update.js";
import { buildWishlistPage } from "../../src/telegram/wishlist.js";
import type { Env } from "../../src/runtime/bindings.js";
import type {
  PriceQuote,
  TelegramUpdate,
  WishlistItem,
} from "../../src/domain/models.js";
import { testDatabase } from "../helpers/sqlite.js";

const game = (n: number) => ({
  id: `018d937f-07fc-72ed-8517-${String(n).padStart(12, "0")}`,
  title: `Game ${n}`,
  slug: `game-${n}`,
  type: "game",
});
const msg = (text: string, id = 1): TelegramUpdate => ({
  update_id: id,
  message: {
    message_id: id,
    text,
    chat: { id: 7, type: "private" },
    from: { id: 7 },
  },
});
const cb = (offset: number, id = 2, user = 7): TelegramUpdate => ({
  update_id: id,
  callback_query: {
    id: "fixture",
    data: `wishlistpage|${offset}`,
    from: { id: user },
    message: { message_id: 42, chat: { id: 7 } },
  },
});
function setup() {
  const db = testDatabase(),
    priceRequests: string[][] = [];
  const env = {
    DB: db.db,
    ITAD_API_KEY: "fixture",
    TELEGRAM_BOT_TOKEN: "fixture",
  } as Env;
  const context = createContext(env, {
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "api.telegram.org")
        return new Response(JSON.stringify({ ok: true, result: true }));
      assert.equal(url.pathname, "/games/prices/v3");
      const ids = JSON.parse(String(init?.body));
      priceRequests.push(ids);
      return new Response(
        JSON.stringify(
          ids.map((id: string) => ({
            id,
            deals: [
              {
                shop: { id: 61, name: "Steam" },
                price: { amountInt: 500, currency: "EUR" },
                regular: { amountInt: 1000, currency: "EUR" },
                cut: 50,
                expiry: null,
                url: "https://store.steampowered.com/app/1/",
              },
            ],
          })),
        ),
      );
    },
  });
  const rows = () =>
    db.sqlite.prepare("SELECT * FROM deliveries ORDER BY rowid").all() as any[];
  return { ...db, context, priceRequests, rows };
}

test("wishlist sends one compact message and edits that message for the next page", async () => {
  const h = setup();
  try {
    for (let n = 0; n < 16; n++)
      await h.context.wishlist.addWishlist("7", null, game(n), null, 1000 - n);
    await handleUpdate(h.context, msg("/wishlist"));
    assert.equal(h.rows().length, 1);
    assert.equal(h.rows()[0].operation, "send");
    assert.match(h.rows()[0].text, /Game 0/);
    assert.match(h.rows()[0].text, /Game 9/);
    assert.ok(!h.rows()[0].text.includes("Game 10"));
    assert.equal(h.priceRequests.length, 1);
    assert.equal(h.priceRequests[0].length, 10);
    assert.equal(
      JSON.parse(h.rows()[0].reply_markup).inline_keyboard[0][0].callback_data,
      "wishlistpage|10",
    );
    await handleUpdate(h.context, cb(10));
    assert.equal(h.rows().length, 2);
    assert.equal(h.rows()[1].operation, "edit");
    assert.equal(h.rows()[1].telegram_message_id, 42);
    assert.match(h.rows()[1].text, /Game 10/);
    assert.match(h.rows()[1].text, /Game 15/);
    assert.equal(h.priceRequests[1].length, 6);
  } finally {
    h.close();
  }
});

test("wishlist callbacks cannot access another user in a private chat", async () => {
  const h = setup();
  try {
    await h.context.wishlist.addWishlist("7", null, game(0), null);
    await handleUpdate(h.context, cb(0, 1, 8));
    assert.equal(h.priceRequests.length, 0);
    assert.ok(h.rows().every((row) => !row.text.includes("Game 0")));
  } finally {
    h.close();
  }
});

test("navigation clamps a removed last page and edits the empty state", async () => {
  const h = setup();
  try {
    await h.context.wishlist.addWishlist("7", null, game(0), null);
    await handleUpdate(h.context, cb(10, 1));
    assert.equal(h.rows().length, 1);
    assert.equal(h.rows()[0].operation, "edit");
    assert.match(h.rows()[0].text, /Game 0/);
    await h.context.wishlist.removeWishlist("7", game(0).id);
    await handleUpdate(h.context, cb(10, 2));
    assert.equal(h.rows()[1].operation, "edit");
    assert.match(h.rows()[1].text, /vuota/);
    assert.deepEqual(JSON.parse(h.rows()[1].reply_markup), {
      inline_keyboard: [],
    });
  } finally {
    h.close();
  }
});

test("wishlist formatting bounds HTML with complete links and separates zero from missing prices", () => {
  const items = Array.from(
    { length: 10 },
    (_, n) =>
      ({
        game_id: game(n).id,
        user_id: "7",
        username: null,
        title: "🎮 <&>".repeat(80),
        added_at: n,
        price_at_add_cents: null,
        baseline_price_cents: null,
        baseline_origin: "initial",
        last_observed_price_cents: null,
        last_notified_price_cents: null,
        min_discount_pct: null,
        last_shop: null,
        last_url: null,
        last_observed_at: null,
        last_notified_at: null,
      }) as WishlistItem,
  );
  const prices = new Map<string, PriceQuote[]>();
  for (let n = 0; n < 9; n++)
    prices.set(game(n).id, [
      {
        gameId: game(n).id,
        shop: "<&>".repeat(100),
        shopId: 61,
        url: "https://example.com/" + "x".repeat(2000),
        priceCents: 0,
        regularCents: 1000,
        cut: 100,
        currency: "EUR",
        expiry: Date.now() + 60000,
      },
    ]);
  const page = buildWishlistPage(items, prices, 0);
  assert.ok(page.text.length <= 3800);
  assert.match(page.text, /GRATIS/);
  assert.match(page.text, /&lt;&amp;&gt;/);
  assert.ok(!page.text.includes("<&>"));
  assert.equal(
    (page.text.match(/<a /g) ?? []).length,
    (page.text.match(/<\/a>/g) ?? []).length,
  );
  assert.ok(
    page.nextOffset !== null && page.nextOffset > 0 && page.nextOffset < 10,
  );
  const missing = buildWishlistPage([items[9]], new Map(), 0);
  assert.match(missing.text, /non disponibile/);
  assert.ok(!missing.text.includes("GRATIS"));
});

test("length-limited pages can advance past a traditional ten-item page boundary", () => {
  const items = Array.from(
    { length: 16 },
    (_, n) =>
      ({
        game_id: game(n).id,
        title: `Game ${n} ` + "<&>".repeat(80),
      }) as WishlistItem,
  );
  const prices = new Map(
    items.map((item) => [
      item.game_id,
      [
        {
          gameId: item.game_id,
          shop: "<&>".repeat(80),
          shopId: 61,
          url: "https://example.com/" + "x".repeat(2000),
          priceCents: 500,
          regularCents: 1000,
          cut: 50,
          currency: "EUR",
          expiry: null,
        } as PriceQuote,
      ],
    ]),
  );
  const page = buildWishlistPage(items, prices, 13);
  assert.match(page.text, /14–14 di 16/);
  assert.equal(page.nextOffset, 14);
});

test("HTML expansion of a long URL cannot exceed the message limit", () => {
  const item = { game_id: game(0).id, title: "<&>".repeat(80) } as WishlistItem;
  const quote = {
    gameId: item.game_id,
    shop: "<&>".repeat(80),
    shopId: 61,
    url: "https://example.com/?" + "&".repeat(2000),
    priceCents: 500,
    regularCents: 1000,
    cut: 50,
    currency: "EUR",
    expiry: null,
  } as PriceQuote;
  assert.ok(
    buildWishlistPage([item], new Map([[item.game_id, [quote]]]), 0).text
      .length <= 3800,
  );
});
