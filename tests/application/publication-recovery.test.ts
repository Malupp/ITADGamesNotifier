import test from "node:test";
import assert from "node:assert/strict";
import { createContext } from "../../src/application/context.js";
import { processUpdate } from "../../src/application/update.js";
import { processDelivery } from "../../src/application/delivery.js";
import type { Env, QueueJob } from "../../src/runtime/bindings.js";
import { testDatabase } from "../helpers/sqlite.js";
function setup() {
  const h = testDatabase(),
    jobs: QueueJob[] = [];
  let fail = true;
  const env = {
    DB: h.db,
    SCANS_ENABLED: "false",
    TELEGRAM_BOT_TOKEN: "fixture",
    ITAD_API_KEY: "fixture",
    WORK_QUEUE: {
      sendBatch: async (batch: { body: QueueJob }[]) => {
        if (fail) throw Error("publication failed");
        jobs.push(...batch.map((x) => x.body));
      },
    },
  } as unknown as Env;
  const context = createContext(env, {
    fetcher: async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: message to edit not found",
        }),
        { status: 400 },
      ),
    recordTiming: () => {},
  });
  return {
    ...h,
    context,
    jobs,
    allowPublication: () => {
      fail = false;
    },
  };
}
test("completed update replay recovers its unpublished reply while scans are paused without rerunning the command", async () => {
  const h = setup(),
    now = Date.now();
  try {
    await h.context.updates.acceptUpdate(
      {
        update_id: 1,
        message: {
          message_id: 1,
          text: "/help",
          chat: { id: 7, type: "private" },
          from: { id: 7 },
        },
      },
      now,
    );
    assert.equal(await processUpdate(1, h.context, now), 60);
    h.allowPublication();
    await processUpdate(1, h.context, now + 60001);
    assert.ok(
      h.jobs.some((x) => x.kind === "delivery" && x.id === "reply:1:0"),
    );
    assert.equal(
      h.sqlite.prepare("SELECT COUNT(*) n FROM deliveries").get()?.n,
      1,
    );
  } finally {
    h.close();
  }
});
test("deleted-message fallback retries a failed publication while scans are paused", async () => {
  const h = setup(),
    now = Date.now() + 1;
  try {
    await h.context.deliveries.queueEdit("reply:8:0", "7", 42, "Page", 8);
    const delay = await processDelivery("reply:8:0", h.context, now).catch(
      () => -1,
    );
    assert.equal(delay, 60);
    h.allowPublication();
    await processDelivery("reply:8:0", h.context, now + 60001);
    assert.ok(
      h.jobs.some((x) => x.kind === "delivery" && x.id === "reply:8:0:reopen"),
    );
    assert.equal(
      h.sqlite
        .prepare("SELECT COUNT(*) n FROM deliveries WHERE operation='send'")
        .get()?.n,
      1,
    );
  } finally {
    h.close();
  }
});
