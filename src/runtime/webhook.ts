import type { ApplicationContext } from "../application/context.js";
import type { TelegramUpdate } from "../domain/models.js";
import { enabled } from "../application/retries.js";
import { enqueueTick, sendJobs } from "./queues.js";
import { keysEnabled } from "../application/keys.js";
export async function handleRequest(
  request: Request,
  context: ApplicationContext,
  now = Date.now(),
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health" && request.method === "GET")
    return Response.json({ ok: true, scansEnabled: enabled(context) });
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (
    !context.env.TELEGRAM_WEBHOOK_SECRET ||
    secret !== context.env.TELEGRAM_WEBHOOK_SECRET
  )
    return new Response("Forbidden", { status: 403 });
  try {
    if (path === "/admin/status" && request.method === "GET") {
      return Response.json({
        ...(await context.settings.status()),
        pricesSeeded:
          (await context.settings.getSetting("prices_seeded")) === "true",
        giveawaysSeeded:
          (await context.settings.getSetting("giveaways_seeded")) === "true",
        keysEnabled: keysEnabled(context),
        keysSeeded:
          (await context.settings.getSetting("keys_seeded")) === "true",
        lastKeyScan: await context.settings.getSetting("last_key_scan"),
        lastKeyError: await context.settings.getSetting("last_key_error"),
      });
    }
    if (path === "/admin/scan" && request.method === "POST") {
      await enqueueTick(context, now, !enabled(context));
      return Response.json({ accepted: true, quiet: !enabled(context) });
    }
    if (path === "/admin/probe" && request.method === "POST") {
      const body = await request.text();
      const compare =
        body.length <= 1024 &&
        body.length > 0 &&
        JSON.parse(body)?.compareReviews === true;
      await sendJobs(
        context,
        compare
          ? [
              { kind: "probe", scenario: "prices" },
              { kind: "probe", scenario: "deals", reviewConcurrency: 1 },
              { kind: "probe", scenario: "deals", reviewConcurrency: 2 },
            ]
          : [
              { kind: "probe", scenario: "deals" },
              { kind: "probe", scenario: "prices" },
            ],
      );
      return Response.json({ accepted: true });
    }
    if (path !== "/telegram" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (Number(request.headers.get("content-length")) > 65536)
      return new Response("Too large", { status: 413 });
    const text = await request.text();
    if (text.length > 65536) return new Response("Too large", { status: 413 });
    let update: TelegramUpdate;
    try {
      update = JSON.parse(text);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (
      !update ||
      !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0
    )
      return new Response("Invalid update", { status: 400 });
    await context.updates.acceptUpdate(update, now); // commit BEFORE acknowledgement
    await (context.env.INTERACTION_QUEUE ?? context.env.WORK_QUEUE).send({
      kind: "update",
      id: update.update_id,
    });
    return new Response("OK");
  } catch {
    return new Response("Retry later", { status: 503 });
  }
}
