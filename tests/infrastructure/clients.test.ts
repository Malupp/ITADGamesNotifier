import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/infrastructure/http.js";
import { ItadClient } from "../../src/infrastructure/itad/client.js";
import { TelegramClient } from "../../src/infrastructure/telegram/client.js";

const id = "018d937f-07fc-72ed-8517-d8e24cb1eb22";
const game = {
  id,
  slug: "example",
  title: "Example",
  type: "game",
  mature: false,
  assets: {},
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const price = (
  amountInt: number | null,
  extra: Record<string, unknown> = {},
) => ({
  shop: { id: 61, name: "Steam" },
  price: {
    amount: amountInt === null ? null : amountInt / 100,
    amountInt,
    currency: "EUR",
  },
  regular: { amount: 100, amountInt: 10000, currency: "EUR" },
  cut: 20,
  voucher: null,
  url: "https://store.steampowered.com/app/1/",
  expiry: "2099-10-08T10:00:00Z",
  ...extra,
});

test("search excludes DLC and malformed games while retaining stable UUIDs", async () => {
  const client = new ItadClient("test-key", async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/games/search/v1");
    assert.equal(url.searchParams.get("title"), "Example & more");
    assert.equal(url.searchParams.has("key"), false);
    assert.equal(new Headers(init?.headers).get("ITAD-API-Key"), "test-key");
    return json([
      { ...game, type: "dlc" },
      game,
      { title: "missing id", type: "game" },
    ]);
  });
  assert.deepEqual(await client.searchGames("Example & more"), [
    { id, slug: "example", title: "Example", type: "game" },
  ]);
});

test("game info loads by UUID, returns null for DLC and missing games", async () => {
  let response = json(game);
  const client = new ItadClient("key", async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/games/info/v2");
    assert.equal(url.searchParams.get("id"), id);
    return response;
  });
  assert.equal((await client.getGameInfo(id))?.id, id);
  response = json({ ...game, type: "dlc" });
  assert.equal(await client.getGameInfo(id), null);
  response = json({}, 404);
  assert.equal(await client.getGameInfo(id), null);
});

test("prices use integer EUR cents, preserve zero and exclude missing, expired or unsafe quotes", async () => {
  const client = new ItadClient("key", async (input, init) => {
    assert.equal(new URL(String(input)).searchParams.get("country"), "IT");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), [id]);
    return json([
      {
        id,
        historyLow: null,
        deals: [
          price(0),
          price(1999),
          price(null),
          price(1500, {
            price: { amountInt: 1500, amount: 15, currency: "USD" },
          }),
          price(1000, { expiry: "2020-01-01T00:00:00Z" }),
          price(1000, { url: "javascript:alert(1)" }),
        ],
      },
    ]);
  });
  const quotes = (await client.getPrices([id])).get(id)!;
  assert.deepEqual(
    quotes.map((q) => q.priceCents),
    [0, 1999],
  );
  assert.equal(quotes[1].regularCents, 10000);
  assert.equal(quotes[1].expiry, Date.parse("2099-10-08T10:00:00Z"));
});

test("prices split arbitrary wishlists into at most ten IDs per request", async () => {
  const sizes: number[] = [];
  const ids = Array.from(
    { length: 23 },
    (_, index) =>
      `018d937f-07fc-72ed-8517-${index.toString().padStart(12, "0")}`,
  );
  const client = new ItadClient("key", async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    sizes.push(body.length);
    return json(body.map((id: string) => ({ id, deals: [price(1200)] })));
  });
  assert.equal((await client.getPrices(ids)).size, 23);
  assert.deepEqual(sizes, [10, 10, 3]);
});

test("giveaway paging is determined from raw records before eligibility filtering", async () => {
  const records = [
    { id: 1, games: [{ ...game, type: "dlc" }] },
    { id: 2, games: [game] },
  ];
  const client = new ItadClient("key", async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/giveaways/v1");
    assert.equal(url.searchParams.get("offset"), "10");
    assert.equal(url.searchParams.get("limit"), "2");
    assert.equal(url.searchParams.get("expired"), "false");
    return json(records);
  });
  assert.deepEqual(await client.getGiveaways(10, 2), {
    items: records,
    hasMore: true,
  });
  await assert.rejects(
    new ItadClient("key", async () =>
      json({ unexpected: true }),
    ).getGiveaways(),
    ApiError,
  );
});

test("deals filter full games, price range, shop, discount and Steam review score", async () => {
  const deal = { ...game, deal: price(900) };
  let infoCalls = 0;
  const client = new ItadClient("key", async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/games/info/v2")
      return json({
        ...game,
        reviews: [
          {
            source: "Steam",
            score: infoCalls++ === 0 ? 80 : 40,
            count: 1000,
            url: "https://store.steampowered.com/app/1/",
          },
        ],
      });
    assert.equal(url.pathname, "/deals/v2");
    assert.equal(url.searchParams.get("country"), "IT");
    assert.equal(url.searchParams.get("shops"), "61");
    return json({
      nextOffset: 4,
      hasMore: false,
      list: [
        deal,
        { ...deal, type: "dlc" },
        { ...deal, deal: price(1200) },
        deal,
      ],
    });
  });
  const result = await client.getDeals({
    maxPriceCents: 1000,
    minPriceCents: 500,
    minCut: 10,
    minScore: 70,
    shopIds: [61],
    limit: 5,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].game.id, id);
  assert.equal(result[0].quote.priceCents, 900);
});

test("Telegram sends HTML and markup, classifies blocked recipients and rate limits without secret leakage", async () => {
  let response = json({ ok: true, result: { message_id: 1 } });
  const client = new TelegramClient("secret-token", async (_input, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.parse_mode, "HTML");
    assert.equal(payload.chat_id, "7");
    assert.equal(
      payload.reply_markup.inline_keyboard[0][0].callback_data,
      "cancel",
    );
    return response;
  });
  const markup = {
    inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
  };
  await client.sendMessage("7", "Hello", markup);
  response = json(
    { ok: false, error_code: 403, description: "secret-token user details" },
    403,
  );
  await assert.rejects(
    client.sendMessage("7", "Hello", markup),
    (error: ApiError) =>
      error.status === 403 &&
      error.permanent &&
      !error.message.includes("secret-token"),
  );
  response = json(
    { ok: false, error_code: 429, parameters: { retry_after: 42 } },
    429,
  );
  await assert.rejects(
    client.sendMessage("7", "Hello", markup),
    (error: ApiError) =>
      error.status === 429 && !error.permanent && error.retryAfter === 42,
  );
});

test("Telegram rejects API failures even with HTTP 200 and acknowledges callback IDs", async () => {
  const client = new TelegramClient("token", async (input, init) => {
    assert.ok(String(input).endsWith("/answerCallbackQuery"));
    assert.deepEqual(JSON.parse(String(init?.body)), {
      callback_query_id: "callback-1",
      text: "OK",
    });
    return json({ ok: false, error_code: 400, description: "query expired" });
  });
  await assert.rejects(
    client.answerCallback("callback-1", "OK"),
    (error: ApiError) => error.status === 400 && error.permanent,
  );
});

test("network exceptions are sanitized and timeout signals are supplied", async () => {
  const client = new ItadClient("secret-key", async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    throw new Error("https://api.example/?key=secret-key private body");
  });
  await assert.rejects(
    client.searchGames("game"),
    (error: ApiError) =>
      error.status === 0 &&
      !error.permanent &&
      !error.message.includes("secret-key"),
  );
});

test("Telegram treats malformed blocked response bodies as permanent recipient failures", async () => {
  const client = new TelegramClient(
    "token",
    async () => new Response("upstream blocked", { status: 403 }),
  );
  await assert.rejects(
    client.sendMessage("7", "Hello"),
    (error: ApiError) => error.status === 403 && error.permanent,
  );
});

test("GET requests do not advertise an absent JSON body", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).has("Content-Type"), false);
    return Response.json({ list: [] });
  };
  assert.deepEqual(
    await new ItadClient("test", fetcher).getDeals({ maxPriceCents: 500 }),
    [],
  );
});
