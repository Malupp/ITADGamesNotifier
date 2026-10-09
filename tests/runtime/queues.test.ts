import assert from "node:assert/strict";
import test from "node:test";
import { createContext } from "../../src/application/context.js";
import { handleRequest } from "../../src/runtime/webhook.js";
import { processJob } from "../../src/runtime/consumer.js";
import { flushDeliveries, enqueueTick } from "../../src/runtime/queues.js";
import { schedule } from "../../src/application/scheduler.js";
import type { Env, QueueJob } from "../../src/runtime/bindings.js";
import { testDatabase } from "../helpers/sqlite.js";

function setup() {
  const db = testDatabase(),
    background: QueueJob[] = [],
    interactive: QueueJob[] = [],
    sent: string[] = [];
  const queue = (jobs: QueueJob[]) => ({
    send: async (body: QueueJob) => {
      jobs.push(body);
      return {};
    },
    sendBatch: async (batch: { body: QueueJob }[]) => {
      jobs.push(...batch.map((x) => x.body));
      return {};
    },
  });
  const env = {
    DB: db.db,
    WORK_QUEUE: queue(background),
    INTERACTION_QUEUE: queue(interactive),
    ITAD_API_KEY: "fixture",
    TELEGRAM_BOT_TOKEN: "fixture",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    SCANS_ENABLED: "true",
  } as unknown as Env;
  const context = createContext(env, {
    fetcher: async (input, init) => {
      assert.equal(new URL(String(input)).hostname, "api.telegram.org");
      sent.push(JSON.parse(String(init?.body)).text);
      return new Response(JSON.stringify({ ok: true, result: true }));
    },
  });
  const update = {
    update_id: 1,
    message: {
      message_id: 1,
      text: "/help",
      chat: { id: 7, type: "private" },
      from: { id: 7 },
    },
  };
  const request = () =>
    new Request("https://bot.test/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify(update),
    });
  return {
    ...db,
    env,
    context,
    background,
    interactive,
    sent,
    request,
    update,
  };
}

test("webhook and replies use the interactive queue while ticks remain background", async () => {
  const h = setup();
  try {
    assert.equal((await handleRequest(h.request(), h.context)).status, 200);
    assert.deepEqual(
      h.interactive.map((x) => x.kind),
      ["update"],
    );
    assert.equal(h.background.length, 0);
    await processJob(h.interactive[0], h.context, Date.now() + 1);
    assert.equal(h.interactive[1].kind, "delivery");
    assert.equal(h.background.length, 0);
    await processJob(h.interactive[1], h.context, Date.now() + 2);
    await processJob(h.interactive[1], h.context, Date.now() + 3);
    assert.equal(h.sent.length, 1);
    await enqueueTick(h.context, Date.now());
    assert.deepEqual(
      h.background.map((x) => x.kind),
      ["tick", "tick", "tick"],
    );
  } finally {
    h.close();
  }
});

test("mixed outbox dispatches each reply and automatic alert to its correct queue", async () => {
  const h = setup();
  try {
    await h.context.deliveries.queueMessage("arbitrary-reply-id", "7", "Reply");
    h.sqlite
      .prepare(
        "INSERT INTO deliveries(id,kind,chat_id,text,due_at) VALUES('campaign','giveaway','7','Alert',?)",
      )
      .run(Date.now());
    await flushDeliveries(h.context, Date.now() + 1);
    assert.deepEqual(h.interactive, [
      { kind: "delivery", id: "arbitrary-reply-id" },
    ]);
    assert.deepEqual(h.background, [{ kind: "delivery", id: "campaign" }]);
  } finally {
    h.close();
  }
});

test("interactive publication failure preserves the update and recovery routes it correctly", async () => {
  const h = setup();
  try {
    h.env.INTERACTION_QUEUE!.send = async () => {
      throw Error("fixture queue failure");
    };
    h.env.INTERACTION_QUEUE!.sendBatch = async () => {
      throw Error("fixture queue failure");
    };
    assert.equal((await handleRequest(h.request(), h.context)).status, 503);
    assert.deepEqual(await h.context.updates.pendingUpdates(Date.now() + 1), [
      1,
    ]);
    h.env.INTERACTION_QUEUE = h.env.WORK_QUEUE;
    await schedule(h.context, Date.now() + 2, false, "recover");
    assert.ok(h.background.some((x) => x.kind === "update" && x.id === 1));
  } finally {
    h.close();
  }
});

test("legacy queue jobs remain processable and paused scans still permit replies", async () => {
  const h = setup();
  try {
    delete h.env.INTERACTION_QUEUE;
    h.env.SCANS_ENABLED = "false";
    assert.equal((await handleRequest(h.request(), h.context)).status, 200);
    await processJob(h.background[0], h.context, Date.now() + 1);
    await processJob(h.background[1], h.context, Date.now() + 2);
    assert.equal(h.sent.length, 1);
  } finally {
    h.close();
  }
});

test("an interactive command progresses independently of an awaiting background API request", async () => {
  const h = setup();
  let release!: () => void;
  let background: Promise<number | null> | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = createContext(h.env, {
      fetcher: async () => {
        started();
        await waiting;
        return new Response("[]");
      },
    });
    await h.context.wishlist.addWishlist(
      "7",
      null,
      {
        id: "018d937f-07fc-72ed-8517-d8e24cb1eb22",
        title: "Game",
        slug: "game",
        type: "game",
      },
      null,
    );
    background = processJob(
      { kind: "probe", scenario: "prices" },
      slow,
      Date.now(),
    );
    await start;
    assert.equal((await handleRequest(h.request(), h.context)).status, 200);
    assert.equal(h.background.length, 0);
    assert.equal(h.interactive.length, 1);
    await processJob(h.interactive[0], h.context, Date.now() + 1);
    assert.equal(h.interactive[1].kind, "delivery");
    release();
    await background;
  } finally {
    release();
    await background?.catch(() => undefined);
    h.close();
  }
});
