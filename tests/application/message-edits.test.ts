import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createContext } from "../../src/application/context.js";
import { processDelivery } from "../../src/application/delivery.js";
import type { Env } from "../../src/runtime/bindings.js";
import { testDatabase } from "../helpers/sqlite.js";

function setup(
  responses: { status?: number; body: unknown }[] = [
    { body: { ok: true, result: true } },
  ],
) {
  const db = testDatabase(),
    calls: { method: string; body: any }[] = [];
  const env = {
    DB: db.db,
    WORK_QUEUE: { send: async () => ({}), sendBatch: async () => ({}) },
    ITAD_API_KEY: "fixture",
    TELEGRAM_BOT_TOKEN: "fixture",
    SCANS_ENABLED: "true",
  } as unknown as Env;
  const context = createContext(env, {
    fetcher: async (input, init) => {
      calls.push({
        method: new URL(String(input)).pathname.split("/").at(-1)!,
        body: JSON.parse(String(init?.body)),
      });
      const next = responses.shift();
      assert.ok(next, "unexpected Telegram request");
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
      });
    },
  });
  return { ...db, context, calls };
}

test("additive edit migration preserves a legacy pending send", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migrations = new URL("../../migrations/", import.meta.url);
    for (const name of [
      "0001_initial.sql",
      "0002_scans.sql",
      "0003_dispatch.sql",
    ])
      db.exec(readFileSync(new URL(name, migrations), "utf8"));
    db.prepare(
      "INSERT INTO deliveries(id,kind,chat_id,text,due_at) VALUES('old','reply','7','Hello',1)",
    ).run();
    db.exec(
      readFileSync(new URL("0004_message_edits.sql", migrations), "utf8"),
    );
    const row = db
      .prepare("SELECT operation,status,telegram_message_id FROM deliveries")
      .get();
    assert.equal(row?.operation, "send");
    assert.equal(row?.status, "pending");
    assert.equal(row?.telegram_message_id, null);
  } finally {
    db.close();
  }
});

test("edit replay persists once and targets the existing message with HTML and keyboard", async () => {
  const h = setup();
  try {
    const keyboard = {
      inline_keyboard: [[{ text: "Avanti", callback_data: "wishlistpage|10" }]],
    };
    for (let n = 0; n < 2; n++)
      await h.context.deliveries.queueEdit(
        "reply:8:0",
        "7",
        42,
        "<b>Pagina 2</b>",
        8,
        keyboard,
      );
    assert.equal(
      h.sqlite.prepare("SELECT COUNT(*) AS n FROM deliveries").get()?.n,
      1,
    );
    await processDelivery("reply:8:0", h.context, Date.now() + 1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, "editMessageText");
    assert.equal(h.calls[0].body.message_id, 42);
    assert.equal(h.calls[0].body.parse_mode, "HTML");
    assert.deepEqual(h.calls[0].body.reply_markup, keyboard);
    assert.equal(
      h.sqlite.prepare("SELECT status FROM deliveries").get()?.status,
      "sent",
    );
  } finally {
    h.close();
  }
});

test("an unchanged Telegram message counts as a successful edit", async () => {
  const h = setup([
    {
      status: 400,
      body: {
        ok: false,
        error_code: 400,
        description:
          "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
      },
    },
  ]);
  try {
    await h.context.deliveries.queueEdit("reply:8:0", "7", 42, "Same page", 8);
    assert.equal(
      await processDelivery("reply:8:0", h.context, Date.now() + 1),
      null,
    );
    assert.equal(
      h.sqlite.prepare("SELECT status FROM deliveries").get()?.status,
      "sent",
    );
    assert.equal(
      h.sqlite.prepare("SELECT COUNT(*) AS n FROM blocked_chats").get()?.n,
      0,
    );
  } finally {
    h.close();
  }
});

test("a missing edited message prompts reopening once without blocking the chat", async () => {
  const h = setup([
    {
      status: 400,
      body: {
        ok: false,
        error_code: 400,
        description: "Bad Request: message to edit not found",
      },
    },
  ]);
  try {
    await h.context.deliveries.queueEdit("reply:8:0", "7", 42, "Page", 8);
    await processDelivery("reply:8:0", h.context, Date.now() + 1);
    await processDelivery("reply:8:0", h.context, Date.now() + 2);
    const rows = h.sqlite
      .prepare("SELECT text FROM deliveries WHERE operation='send'")
      .all();
    assert.equal(rows.length, 1);
    assert.match(String(rows[0].text), /\/wishlist/);
    assert.equal(
      h.sqlite.prepare("SELECT COUNT(*) AS n FROM blocked_chats").get()?.n,
      0,
    );
  } finally {
    h.close();
  }
});

test("an edit rate limit preserves a retry and then completes on Telegram acceptance", async () => {
  const h = setup([
    {
      status: 429,
      body: { ok: false, error_code: 429, parameters: { retry_after: 60 } },
    },
    { body: { ok: true, result: true } },
  ]);
  try {
    await h.context.deliveries.queueEdit("reply:8:0", "7", 42, "Page", 8);
    const now = Date.now() + 1;
    assert.equal(await processDelivery("reply:8:0", h.context, now), 60);
    const row = h.sqlite.prepare("SELECT status,due_at FROM deliveries").get();
    assert.equal(row?.status, "pending");
    assert.equal(row?.due_at, now + 60000);
    await processDelivery("reply:8:0", h.context, now + 60001);
    assert.equal(h.calls.length, 2);
    assert.equal(
      h.sqlite.prepare("SELECT status FROM deliveries").get()?.status,
      "sent",
    );
  } finally {
    h.close();
  }
});

test("a replayed older page cannot overwrite a newer revision for the same message", async () => {
  const h = setup();
  try {
    await h.context.deliveries.queueEdit("reply:8:0", "7", 42, "Old page", 8);
    await h.context.deliveries.queueEdit("reply:9:0", "7", 42, "New page", 9);
    await processDelivery("reply:9:0", h.context, Date.now() + 1);
    await processDelivery("reply:8:0", h.context, Date.now() + 2);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].body.text, "New page");
    assert.equal(
      h.sqlite
        .prepare("SELECT status FROM deliveries WHERE id='reply:8:0'")
        .get()?.status,
      "expired",
    );
  } finally {
    h.close();
  }
});

test("different consumers serialize edits of the same message across an in-flight request", async () => {
  const h = setup(),
    applied: string[] = [];
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    start = new Promise<void>((resolve) => {
      started = resolve;
    });
  let older: Promise<number | null> | undefined;
  try {
    h.context.telegram.editMessage = async (_chat, _id, text) => {
      if (text === "Old page") {
        started();
        await held;
      }
      applied.push(text);
    };
    await h.context.deliveries.queueEdit("reply:8:0", "7", 42, "Old page", 8);
    older = processDelivery("reply:8:0", h.context, Date.now() + 1);
    await start;
    await h.context.deliveries.queueEdit("reply:9:0", "7", 42, "New page", 9);
    const newer = await processDelivery("reply:9:0", h.context, Date.now() + 2);
    assert.equal(newer, 2);
    assert.deepEqual(applied, []);
    release();
    await older;
    await processDelivery("reply:9:0", h.context, Date.now() + 2003);
    assert.deepEqual(applied, ["Old page", "New page"]);
  } finally {
    release();
    await older?.catch(() => undefined);
    h.close();
  }
});
