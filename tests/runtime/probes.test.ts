import assert from "node:assert/strict";
import test from "node:test";
import { createContext } from "../../src/application/context.js";
import { handleRequest } from "../../src/runtime/webhook.js";
import type { Env, QueueJob } from "../../src/runtime/bindings.js";
import { testDatabase } from "../helpers/sqlite.js";
test("authenticated comparative probe queues bounded modes without Telegram updates", async () => {
  const h = testDatabase(),
    jobs: QueueJob[] = [];
  try {
    const context = createContext({
      DB: h.db,
      WORK_QUEUE: {
        sendBatch: async (batch: { body: QueueJob }[]) => {
          jobs.push(...batch.map((x) => x.body));
        },
      },
      TELEGRAM_WEBHOOK_SECRET: "fixture",
    } as unknown as Env);
    const request = new Request("https://bot.test/admin/probe", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "fixture" },
      body: JSON.stringify({ compareReviews: true }),
    });
    assert.equal((await handleRequest(request, context)).status, 200);
    assert.deepEqual(jobs, [
      { kind: "probe", scenario: "prices" },
      { kind: "probe", scenario: "deals", reviewConcurrency: 1 },
      { kind: "probe", scenario: "deals", reviewConcurrency: 2 },
    ]);
    assert.equal(
      h.sqlite.prepare("SELECT COUNT(*) n FROM deliveries").get()?.n,
      0,
    );
  } finally {
    h.close();
  }
});
