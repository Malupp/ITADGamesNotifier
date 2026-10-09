import test from "node:test";
import assert from "node:assert/strict";
import { TelegramClient } from "../../src/infrastructure/telegram/client.js";
import { createContext } from "../../src/application/context.js";
import { processDelivery } from "../../src/application/delivery.js";
import type { Env } from "../../src/runtime/bindings.js";
import { testDatabase } from "../helpers/sqlite.js";
test("giveaway send enables a large preview for the validated store link, ordinary reply and edit stay compact", async () => {
  const calls: any[] = [];
  const client = new TelegramClient("fixture", async (_, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: true });
  });
  await client.sendMessage(
    "7",
    "Giveaway",
    undefined,
    "https://store.steampowered.com/app/123/",
  );
  await client.sendMessage("7", "Help");
  await client.editMessage("7", 42, "Wishlist");
  assert.deepEqual(calls[0].link_preview_options, {
    is_disabled: false,
    url: "https://store.steampowered.com/app/123/",
    prefer_large_media: true,
  });
  assert.deepEqual(calls[1].link_preview_options, { is_disabled: true });
  assert.deepEqual(calls[2].link_preview_options, { is_disabled: true });
});
test("giveaway delivery enables only its freshly verified official URL", async () => {
  const h = testDatabase(),
    calls: any[] = [],
    now = Date.now(),
    id = "018d937f-07fc-72ed-8517-d8e24cb1eb22",
    url = "https://store.steampowered.com/app/123/";
  try {
    const context = createContext(
      {
        DB: h.db,
        ITAD_API_KEY: "fixture",
        TELEGRAM_BOT_TOKEN: "fixture",
        SCANS_ENABLED: "true",
      } as Env,
      {
        fetcher: async (input, init) => {
          const u = new URL(String(input));
          if (u.hostname === "api.telegram.org") {
            calls.push(JSON.parse(String(init?.body)));
            return Response.json({ ok: true, result: true });
          }
          if (u.pathname === "/games/prices/v3")
            return Response.json([
              {
                id,
                deals: [
                  {
                    shop: { id: 61, name: "Steam" },
                    url,
                    price: { amountInt: 0, currency: "EUR" },
                    regular: { amountInt: 1000, currency: "EUR" },
                    cut: 100,
                    expiry: null,
                  },
                ],
              },
            ]);
          return Response.json({
            "123": {
              success: true,
              data: {
                type: "game",
                is_free: false,
                price_overview: {
                  currency: "EUR",
                  initial: 1000,
                  final: 0,
                  discount_percent: 100,
                },
              },
            },
          });
        },
      },
    );
    await context.giveaways.ingestGiveaways(
      [
        {
          id: "itad:123:" + id,
          gameId: id,
          slug: "game",
          title: "Game",
          shop: "Steam",
          url,
          expiry: now + 3600000,
        },
      ],
      ["7"],
      now,
      false,
    );
    const [delivery] = await context.deliveries.pendingDeliveries(now);
    await processDelivery(delivery, context, now);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].link_preview_options.url, url);
    assert.equal(calls[0].link_preview_options.is_disabled, false);
  } finally {
    h.close();
  }
});
