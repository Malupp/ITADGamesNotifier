import assert from "node:assert/strict";
import test from "node:test";
import { createContext } from "../../src/application/context.js";
import { handleUpdate } from "../../src/application/update.js";
import type { Env } from "../../src/runtime/bindings.js";
import type { TelegramUpdate } from "../../src/domain/models.js";
import { testDatabase } from "../helpers/sqlite.js";

const game = (n: number) => ({ id: `018d937f-07fc-72ed-8517-${String(n).padStart(12, "0")}`, title: `Game ${n}`, slug: `game-${n}`, type: "game" });
const msg = (text: string, update_id = 1, chat = 7): TelegramUpdate => ({ update_id, message: { message_id: update_id, text, from: { id: 7 }, chat: { id: chat, type: chat === 7 ? "private" : "group" } } });
const cb = (data: string, update_id = 2, user = 7, chat = 7): TelegramUpdate => ({ update_id, callback_query: { id: "fixture", data, from: { id: user }, message: { message_id: 42, chat: { id: chat } } } });
function setup() {
  const h = testDatabase();
  let now = Date.now();
  let emptyPrices = false;
  const calls: string[] = [];
  const env = { DB: h.db, TELEGRAM_BOT_TOKEN: "fixture", ITAD_API_KEY: "fixture" } as Env;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const quote = (n: number) => ({ shop: { id: [61,35,16,6][n % 4], name: `Shop ${n}` }, price: { amountInt: 500 + n, currency: "EUR" }, regular: { amountInt: 1000, currency: "EUR" }, cut: 50, expiry: null, url: `https://example.com/${n}?a=1&b=2&padding=${"x".repeat(400)}` });
    let data: unknown;
    if (url.hostname === "api.telegram.org") data = { ok: true, result: true };
    else if (url.pathname === "/games/search/v1") data = [game(0), game(1)];
    else if (url.pathname === "/games/info/v2") data = { ...game(url.searchParams.get("id") === game(0).id ? 0 : 1), reviews: [{ source: "Steam", score: 90 }] };
    else if (url.pathname === "/games/prices/v3") data = JSON.parse(String(init?.body)).map((id: string) => ({ id, deals: emptyPrices ? [] : Array.from({ length: 12 }, (_, n) => quote(n)) }));
    else if (url.pathname === "/deals/v2") data = { list: Array.from({ length: 30 }, (_, n) => ({ ...game(n), deal: quote(n) })), hasMore: false };
    else throw new Error("Unexpected endpoint");
    return new Response(JSON.stringify(data));
  };
  const context = () => createContext(env, { fetcher, now: () => now, recordTiming: () => {} });
  const rows = () => h.sqlite.prepare("SELECT * FROM deliveries ORDER BY rowid").all() as any[];
  return { ...h, context, rows, calls, empty() { emptyPrices = true; }, advance(milliseconds: number) { now += milliseconds; }, expire() { now += 2 * 86400000; } };
}
const buttons = (row: any): any[] => row.reply_markup ? JSON.parse(row.reply_markup).inline_keyboard.flat() : [];

test("search selection edits one message containing all shop quotes and returns to the title choices", async () => {
  const h = setup();
  try {
    await handleUpdate(h.context(), msg("/cerca Game"));
    const selection = buttons(h.rows()[0])[0].callback_data;
    await handleUpdate(h.context(), cb(selection));
    assert.equal(h.rows().length, 2, "one send and one edit, never a send per shop");
    const prices = h.rows()[1];
    assert.equal(prices.operation, "edit");
    assert.equal(prices.telegram_message_id, 42);
    assert.match(prices.text, /Shop 0/);
    assert.match(prices.text, /Shop 1/);
    const back = buttons(prices).find(b => /titoli/i.test(b.text));
    assert.ok(back, "keep the ability to choose another search result");
    await handleUpdate(h.context(), cb(back.callback_data, 3));
    assert.equal(h.rows()[2].operation, "edit");
    assert.ok(buttons(h.rows()[2]).some(b => b.text === "Game 1"));
    h.empty();
    await handleUpdate(h.context(), cb(buttons(h.rows()[2])[1].callback_data, 4));
    assert.equal(h.rows()[3].operation, "edit");
    assert.match(h.rows()[3].text, /Nessun prezzo/);
    assert.ok(buttons(h.rows()[3]).some(b => /titoli/i.test(b.text)));
  } finally { h.close(); }
});

for (const command of ["/confronta Game", "/offerte 20 20 0", "/offerte_shop 1-20 30 steam,gog"]) {
  test(`${command} sends one paginated message without dropping results`, async () => {
    const h = setup();
    try {
      await handleUpdate(h.context(), msg(command));
      assert.equal(h.rows().length, 1);
      let current = h.rows()[0], text = current.text, update = 2;
      const expected = command.startsWith("/confronta") ? "Shop 11" : "Game 29";
      while (buttons(current).some(b => /Avanti/.test(b.text))) {
        const next = buttons(current).find(b => /Avanti/.test(b.text));
        await handleUpdate(h.context(), cb(next.callback_data, update++));
        current = h.rows().at(-1);
        assert.equal(current.operation, "edit");
        assert.equal(current.telegram_message_id, 42);
        assert.ok(current.text.length <= 3800);
        text += current.text;
        assert.ok(update < 40);
      }
      // /offerte requests five results; the upstream fixture must be bounded by the client.
      assert.match(text, new RegExp(command.startsWith("/offerte ") ? "Game 4" : expected));
      assert.equal(h.rows().filter(r => r.operation === "send").length, 1);
    } finally { h.close(); }
  });
}

test("deals returns a single message with every cached gift", async () => {
  const h = setup();
  try {
    await h.context().giveaways.ingestGiveaways(Array.from({ length: 3 }, (_, n) => ({ id: `gift-${n}`, gameId: game(n).id, slug: game(n).slug, title: game(n).title, shop: "Epic Games Store", url: `https://store.epicgames.com/p/game-${n}`, expiry: Date.now() + 86400000 })), [], Date.now(), true);
    await handleUpdate(h.context(), msg("/deals"));
    assert.equal(h.rows().length, 1);
    for (let n = 0; n < 3; n++) assert.match(h.rows()[0].text, new RegExp(`Game ${n}`));
  } finally { h.close(); }
});

test("add, remove, per-game threshold and cancel callbacks update the existing message", async () => {
  const h = setup();
  try {
    await handleUpdate(h.context(), cb(`addwish|${game(0).id}`, 1));
    await handleUpdate(h.context(), cb(`setscontog|${game(0).id}`, 2));
    await handleUpdate(h.context(), cb(`setscontog_apply|${game(0).id}|20`, 3));
    await handleUpdate(h.context(), cb(`remwish|${game(0).id}`, 4));
    await handleUpdate(h.context(), cb("cancel", 5));
    assert.equal(h.rows().length, 5);
    assert.ok(h.rows().every(r => r.operation === "edit" && r.telegram_message_id === 42));
    assert.deepEqual(JSON.parse(h.rows().at(-1).reply_markup), { inline_keyboard: [] });
    assert.equal((await h.context().wishlist.getWishlist("7")).length, 0);
  } finally { h.close(); }
});

test("remove and discount list navigation edits the same message", async () => {
  const h = setup();
  try {
    for (let n = 0; n < 12; n++) await h.context().wishlist.addWishlist("7", null, game(n), null, 1000 - n);
    await handleUpdate(h.context(), msg("/remove"));
    await handleUpdate(h.context(), cb("rempage|10", 2));
    await handleUpdate(h.context(), msg("/setscontog", 3));
    await handleUpdate(h.context(), cb("discpage|10", 4));
    assert.deepEqual(h.rows().map(r => r.operation), ["send", "edit", "send", "edit"]);
  } finally { h.close(); }
});

test("another user cannot navigate or select a saved group search", async () => {
  const h = setup();
  try {
    await handleUpdate(h.context(), msg("/cerca Game", 1, -100));
    const selection = buttons(h.rows()[0])[0].callback_data;
    await handleUpdate(h.context(), cb(selection, 2, 8, -100));
    assert.equal(h.rows().length, 1);
    assert.ok(!h.calls.includes("/games/prices/v3"));
    await handleUpdate(h.context(), cb(selection, 3, 7, -100));
    const prices = h.rows().at(-1);
    const next = buttons(prices).find(b => /Avanti|titoli/i.test(b.text));
    assert.ok(next);
    await handleUpdate(h.context(), cb(next.callback_data, 4, 8, -100));
    assert.equal(h.rows().length, 2);
  } finally { h.close(); }
});

test("expired result pages explain reopening in the same message", async () => {
  const h = setup();
  try {
    await handleUpdate(h.context(), msg("/offerte_shop 1-20 30 steam"));
    const next = buttons(h.rows()[0]).find(b => /Avanti/.test(b.text));
    assert.ok(next);
    h.expire();
    await handleUpdate(h.context(), cb(next.callback_data));
    assert.equal(h.rows().length, 2);
    assert.equal(h.rows()[1].operation, "edit");
    assert.match(h.rows()[1].text, /scadut|Riprova|Ripeti/);
    assert.deepEqual(JSON.parse(h.rows()[1].reply_markup), { inline_keyboard: [] });
  } finally { h.close(); }
});


test("another group member cannot cancel a saved search", async () => {
  const h = setup();
  try {
    await handleUpdate(h.context(), msg("/cerca Game", 1, -100));
    const cancel = buttons(h.rows()[0]).find(b => /Annulla/.test(b.text));
    assert.ok(cancel);
    await handleUpdate(h.context(), cb(cancel.callback_data, 2, 8, -100));
    assert.equal(h.rows().length, 1);
    await handleUpdate(h.context(), cb(cancel.callback_data, 3, 7, -100));
    assert.equal(h.rows()[1].operation, "edit");
    assert.deepEqual(JSON.parse(h.rows()[1].reply_markup), { inline_keyboard: [] });
  } finally { h.close(); }
});

test("a pruned group view cannot be overwritten by a different user", async () => {
  const h = setup();
  try {
    await handleUpdate(h.context(), msg("/offerte_shop 1-20 30 steam,gog", 1, -100));
    const next = buttons(h.rows()[0]).find(b => /Avanti/.test(b.text));
    assert.ok(next);
    h.expire();
    await h.context().views.prune(h.context().now());
    await handleUpdate(h.context(), cb(next.callback_data, 2, 8, -100));
    assert.equal(h.rows().length, 1);
  } finally { h.close(); }
});

test("giveaway pages stop being navigable when an included promotion expires", async () => {
  const h = setup();
  try {
    await h.context().giveaways.ingestGiveaways(Array.from({ length: 10 }, (_, n) => ({ id: `gift-${n}`, gameId: game(n).id, slug: game(n).slug, title: game(n).title, shop: "Epic Games Store", url: `https://store.epicgames.com/p/game-${n}?padding=${"x".repeat(500)}`, expiry: h.context().now() + 60000 })), [], h.context().now(), true);
    await handleUpdate(h.context(), msg("/deals"));
    const next = buttons(h.rows()[0]).find(b => /Avanti/.test(b.text));
    assert.ok(next);
    // Expired offers must not return from a saved navigation snapshot.
    h.advance(60001);
    await handleUpdate(h.context(), cb(next.callback_data));
    assert.match(h.rows()[1].text, /scaduta/);
    assert.equal(h.rows()[1].operation, "edit");
  } finally { h.close(); }
});


test("deals keeps all active gifts even when more than ten are cached", async () => {
  const h = setup();
  try {
    await h.context().giveaways.ingestGiveaways(Array.from({ length: 12 }, (_, n) => ({ id: `gift-${n}`, gameId: game(n).id, slug: game(n).slug, title: game(n).title, shop: "Epic", url: `https://store.epicgames.com/p/game-${n}?padding=${"x".repeat(400)}`, expiry: h.context().now() + 86400000 })), [], h.context().now(), true);
    await handleUpdate(h.context(), msg("/deals"));
    let current = h.rows()[0], text = current.text, update = 2;
    while (buttons(current).some(b => /Avanti/.test(b.text))) {
      await handleUpdate(h.context(), cb(buttons(current).find(b => /Avanti/.test(b.text)).callback_data, update++));
      current = h.rows().at(-1);
      text += current.text;
    }
    for (let n = 0; n < 12; n++) assert.match(text, new RegExp(`Game ${n}\\b`));
    assert.equal(h.rows().filter(r => r.operation === "send").length, 1);
  } finally { h.close(); }
});

test("expired giveaway snapshots are not delivered by either queued send or edit", async () => {
  const h = setup();
  try {
    await h.context().giveaways.ingestGiveaways(Array.from({ length: 8 }, (_, n) => ({ id: `gift-${n}`, gameId: game(n).id, slug: game(n).slug, title: game(n).title, shop: "Epic", url: `https://store.epicgames.com/p/game-${n}?padding=${"x".repeat(500)}`, expiry: h.context().now() + 60000 })), [], h.context().now(), true);
    await handleUpdate(h.context(), msg("/deals"));
    const first = h.rows()[0];
    const next = buttons(first).find(b => /Avanti/.test(b.text));
    assert.ok(next);
    await handleUpdate(h.context(), cb(next.callback_data));
    assert.equal(h.rows()[1].operation, "edit");
    h.advance(61000);
    const { processDelivery } = await import("../../src/application/delivery.js");
    for (const row of h.rows()) await processDelivery(row.id, h.context(), h.context().now());
    assert.equal(h.calls.filter(path => /sendMessage|editMessageText/.test(path)).length, 0);
  } finally { h.close(); }
});

test("view cleanup preserves other settings even if their names resemble the namespace", async () => {
  const h = setup();
  try {
    const old = h.context().now() - 2 * 86400000;
    await h.context().settings.setSetting("prices_seeded", "true", old);
    await h.context().settings.setSetting("telegramXview:keep", "important", old);
    await h.context().settings.setSetting("telegram_view:1", "{}", old);
    await h.context().views.prune(h.context().now());
    assert.equal(await h.context().settings.getSetting("prices_seeded"), "true");
    assert.equal(await h.context().settings.getSetting("telegramXview:keep"), "important");
    assert.equal(await h.context().settings.getSetting("telegram_view:1"), null);
  } finally { h.close(); }
});
