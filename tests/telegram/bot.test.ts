import { createContext } from "../../src/application/context.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate } from "../../src/application/update.js";
import { Store } from "../../src/infrastructure/d1/store.js";
import { testDatabase } from "../helpers/sqlite.js";
import type { Env } from "../../src/runtime/bindings.js";
import type { TelegramUpdate } from "../../src/domain/models.js";

const id = "018d937f-07fc-72ed-8517-d8e24cb1eb22";
const id2 = "018d937f-07fc-72ed-8517-d8e24cb1eb23";
const game = {
  id,
  title: "<Example & Friends>",
  slug: "example",
  type: "game",
};
const quote = {
  shop: { id: 61, name: "Steam & more" },
  price: { amount: 0, amountInt: 0, currency: "EUR" },
  regular: { amount: 10, amountInt: 1000, currency: "EUR" },
  cut: 100,
  expiry: null,
  url: "https://example.com/?a=1&b=2",
};
const response = (value: unknown) => new Response(JSON.stringify(value));

function setup() {
  const database = testDatabase();
  const env = {
    DB: database.db,
    ITAD_API_KEY: "fake",
    TELEGRAM_BOT_TOKEN: "fake",
    TELEGRAM_WEBHOOK_SECRET: "fake",
    WORK_QUEUE: {},
  } as Env;
  const calls: { url: URL; body: any }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.hostname === "api.telegram.org") {
      assert.ok(
        url.pathname.endsWith("/answerCallbackQuery"),
        "all messages must use the durable outbox",
      );
      return response({ ok: true, result: true });
    }
    if (url.pathname === "/games/search/v1")
      return response([game, { ...game, id: id2, title: "Second" }]);
    if (url.pathname === "/games/info/v2")
      return response({
        ...game,
        id: url.searchParams.get("id"),
        reviews: [{ source: "Steam", score: 90 }],
      });
    if (url.pathname === "/games/prices/v3")
      return response(body.map((id: string) => ({ id, deals: [quote] })));
    if (url.pathname === "/deals/v2")
      return response({
        list: [
          {
            ...game,
            deal: {
              ...quote,
              price: { amount: 5, amountInt: 500, currency: "EUR" },
              cut: 50,
            },
          },
        ],
        hasMore: false,
      });
    throw new Error("Unexpected network endpoint");
  };
  const replies = () =>
    database.sqlite
      .prepare("SELECT * FROM deliveries ORDER BY rowid")
      .all() as any[];
  return {
    ...database,
    env,
    fetcher,
    calls,
    replies,
    store: new Store(database.db),
    cleanup() {
      database.close();
    },
  };
}
const message = (text: string, update_id = 1, chatId = 7): TelegramUpdate => ({
  update_id,
  message: {
    message_id: update_id,
    text,
    chat: { id: chatId, type: chatId === 7 ? "private" : "group" },
    from: { id: 7, username: "tester" },
  },
});
const callback = (data: string, update_id = 1, chatId = 7): TelegramUpdate => ({
  update_id,
  callback_query: {
    id: "callback-id",
    data,
    from: { id: 7, username: "tester" },
    message: { message_id: 1, chat: { id: chatId } },
  },
});

test("search results carry stable UUID callbacks and replies are persisted with update replay keys", async () => {
  const h = setup();
  try {
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/cerca Example"),
    );
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/cerca Example"),
    );
    const rows = h.replies();
    assert.equal(rows.length, 1);
    assert.match(rows[0].idempotency_key ?? rows[0].id, /reply:1:0/);
    const markup = JSON.parse(rows[0].reply_markup);
    assert.equal(markup.inline_keyboard[0][0].callback_data, `price|${id}|1`);
  } finally {
    h.cleanup();
  }
});

test("UUID add callbacks survive unrelated searches and preserve a zero baseline", async () => {
  const h = setup();
  try {
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/cerca Second", 1),
    );
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback(`addwish|${id}`, 2),
    );
    const wishlist = await h.store.getWishlist("7");
    assert.equal(wishlist.length, 1);
    assert.equal(wishlist[0].game_id, id);
    assert.equal(wishlist[0].price_at_add_cents, 0);
    assert.ok(
      h.calls.some(
        (call) =>
          call.url.pathname === "/games/info/v2" &&
          call.url.searchParams.get("id") === id,
      ),
    );
    assert.ok(
      h
        .replies()
        .some((row) => row.text.includes("&lt;Example &amp; Friends&gt;")),
    );
  } finally {
    h.cleanup();
  }
});

test("price callback displays HTML escaped metadata and correctly escaped HTTPS links", async () => {
  const h = setup();
  try {
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback(`price|${id}`),
    );
    const text = h.replies()[0].text;
    assert.ok(text.includes("&lt;Example &amp; Friends&gt;"));
    assert.ok(text.includes("Steam &amp; more"));
    assert.ok(text.includes('href="https://example.com/?a=1&amp;b=2"'));
    assert.ok(text.includes("GRATIS"));
  } finally {
    h.cleanup();
  }
});

test("group wishlist commands and mutation callbacks cannot expose or alter personal state", async () => {
  const h = setup();
  try {
    await h.store.addWishlist("7", "tester", game, null);
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/wishlist", 1, -20),
    );
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback(`remwish|${id}`, 2, -20),
    );
    assert.equal((await h.store.getWishlist("7")).length, 1);
    assert.ok(h.replies().every((row) => !row.text.includes("Example")));
    assert.ok(h.replies().every((row) => row.text.includes("privat")));
  } finally {
    h.cleanup();
  }
});

test("global and per game thresholds enforce ten percent and nullable global inheritance", async () => {
  const h = setup();
  try {
    await h.store.addWishlist("7", "tester", game, null);
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/setsconto 9", 1),
    );
    assert.equal((await h.store.getPrefs("7")).minDiscountPct, 10);
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/setsconto 20", 2),
    );
    assert.equal((await h.store.getPrefs("7")).minDiscountPct, 20);
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback(`setscontog_apply|${id}|30`, 3),
    );
    assert.equal((await h.store.getWishlist("7"))[0].min_discount_pct, 30);
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback(`setscontog_apply|${id}|None`, 4),
    );
    assert.equal((await h.store.getWishlist("7"))[0].min_discount_pct, null);
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback(`setscontog_apply|${id}|9`, 5),
    );
    assert.equal((await h.store.getWishlist("7"))[0].min_discount_pct, null);
  } finally {
    h.cleanup();
  }
});

test("add keeps monitoring when the initial price API is unavailable", async () => {
  const h = setup();
  try {
    const fetcher = h.fetcher;
    h.fetcher = async (input, init) =>
      new URL(String(input)).pathname === "/games/prices/v3"
        ? new Response("{}", { status: 503 })
        : fetcher(input, init);
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback(`addwish|${id}`),
    );
    const wishlist = await h.store.getWishlist("7");
    assert.equal(wishlist.length, 1);
    assert.equal(wishlist[0].baseline_price_cents, null);
  } finally {
    h.cleanup();
  }
});

test("callbacks reject stale search indexes and unknown commands cause no network or outbox writes", async () => {
  const h = setup();
  try {
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/not_a_command"),
    );
    assert.equal(h.replies().length, 0);
    assert.equal(h.calls.length, 0);
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback("addwish|0", 2),
    );
    assert.equal((await h.store.getWishlist("7")).length, 0);
    assert.ok(h.replies()[0].text.includes("/add"));
  } finally {
    h.cleanup();
  }
});

test("settings parse comma decimals and offer search retains filters and range/shop syntax", async () => {
  const h = setup();
  try {
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/setsoglia prezzo 12,50", 1),
    );
    assert.equal((await h.store.getPrefs("7")).thresholdCents, 1250);
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/offerte_shop 4-8 steam,gog", 2),
    );
    const dealsCall = h.calls.find((call) => call.url.pathname === "/deals/v2");
    assert.ok(dealsCall);
    assert.equal(dealsCall.url.searchParams.get("shops"), "61,35");
    assert.ok(h.replies().some((row) => row.text.includes("5,00")));
  } finally {
    h.cleanup();
  }
});

test("help and status explain thirty minute monitoring and confirmed delivery references", async () => {
  const h = setup();
  try {
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/help", 1),
    );
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/status", 2),
    );
    assert.ok(h.replies()[0].text.includes("30 minuti"));
    assert.ok(h.replies()[0].text.includes("10%"));
    assert.ok(h.replies()[0].text.includes("ultima notifica"));
    assert.ok(h.replies()[1].text.includes("Scansione"));
  } finally {
    h.cleanup();
  }
});

test("wishlist pages process at most ten games and callbacks navigate without search sessions", async () => {
  const h = setup();
  try {
    for (let index = 0; index < 11; index++) {
      await h.store.addWishlist(
        "7",
        "tester",
        {
          ...game,
          id: `018d937f-07fc-72ed-8517-${String(index).padStart(12, "0")}`,
          title: `Game ${index}`,
        },
        null,
      );
    }
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      message("/wishlist", 1),
    );
    assert.equal(
      h.replies().filter((row) => row.text.includes("🎮")).length,
      1,
    );
    const navigation = h.replies().find((row) => row.reply_markup);
    assert.equal(
      JSON.parse(navigation.reply_markup).inline_keyboard[0][0].callback_data,
      "wishlistpage|10",
    );
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback("wishlistpage|10", 2),
    );
    assert.equal(
      h.replies().filter((row) => row.text.includes("🎮")).length,
      2,
    );
  } finally {
    h.cleanup();
  }
});

test("failed callback acknowledgement does not prevent a valid wishlist operation", async () => {
  const h = setup();
  try {
    const fetcher = h.fetcher;
    h.fetcher = async (input, init) =>
      new URL(String(input)).hostname === "api.telegram.org"
        ? new Response("{}", { status: 400 })
        : fetcher(input, init);
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback(`addwish|${id}`),
    );
    assert.equal((await h.store.getWishlist("7")).length, 1);
    assert.equal(h.replies().length, 1);
  } finally {
    h.cleanup();
  }
});

test("private callbacks can only mutate the requesting user wishlist", async () => {
  const h = setup();
  try {
    await h.store.addWishlist("8", "someone", game, null);
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback(`remwish|${id}`, 1),
    );
    await handleUpdate(
      createContext(h.env, { fetcher: h.fetcher }),
      callback(`setscontog_apply|${id}|30`, 2),
    );
    const other = await h.store.getWishlist("8");
    assert.equal(other.length, 1);
    assert.equal(other[0].min_discount_pct, null);
    assert.ok(h.replies().every((row) => !row.text.includes("Example")));
  } finally {
    h.cleanup();
  }
});
