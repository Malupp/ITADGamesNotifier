import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/sqlite.js";
import { createContext } from "../../src/application/context.js";
import { createSession } from "../../src/telegram/session.js";
import { handleCommand } from "../../src/telegram/commands.js";
import { handleCallback } from "../../src/telegram/callbacks.js";
import { processUpdate } from "../../src/application/update.js";
import type { Env } from "../../src/runtime/bindings.js";
function fixture(
  type = "supergroup",
  role = "administrator",
  botRole = "administrator",
  broken = false,
) {
  let time = 100000;
  const d = testDatabase();
  const methods: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const method = String(url).split("/").at(-1)!;
    methods.push(method);
    const body = JSON.parse(String(init?.body));
    if (broken)
      return Response.json({ ok: false, error_code: 503 }, { status: 503 });
    const result =
      method === "getMe"
        ? { id: 99, is_bot: true }
        : method === "getChat"
          ? { id: Number(body.chat_id), type }
          : method === "getChatMember"
            ? {
                user: { id: body.user_id },
                status: body.user_id === 99 ? botRole : role,
              }
            : true;
    return Response.json({ ok: true, result });
  };
  const c = createContext(
    {
      DB: d.db,
      WORK_QUEUE: { sendBatch: async () => {}, send: async () => {} } as any,
      TELEGRAM_BOT_TOKEN: "fake",
      ITAD_API_KEY: "",
      TELEGRAM_WEBHOOK_SECRET: "",
      NEWS_ENABLED: "true",
    } as Env,
    { fetcher, now: () => time },
  );
  const session = (
    id: number,
    text = "/news on",
    chat = -1,
    user = 1,
    data?: string,
  ) =>
    createSession(
      c,
      data
        ? {
            update_id: id,
            callback_query: {
              id: "c" + id,
              from: { id: user },
              data,
              message: { message_id: 2, chat: { id: chat } },
            },
          }
        : {
            update_id: id,
            message: {
              message_id: 1,
              from: { id: user },
              chat: { id: chat, type },
              text,
            },
          },
    )!;
  return {
    d,
    c,
    session,
    methods,
    get time() {
      return time;
    },
    set time(value: number) {
      time = value;
    },
  };
}
test("admin and owner can change one group toggle; members cannot; groups remain isolated", async (t) => {
  for (const role of ["administrator", "creator", "member"]) {
    const f = fixture("supergroup", role);
    t.after(f.d.close);
    await handleCommand(f.session(1));
    assert.equal(
      (await f.c.news.group("-1")).enabled,
      role === "member" ? 0 : 1,
    );
    assert.equal((await f.c.news.group("-2")).enabled, 0);
  }
});
test("private, channels, anonymous sender and unavailable/demoted bot cannot enable news", async (t) => {
  for (const [type, role, bot, broken, user, chat] of [
    ["private", "administrator", "administrator", false, 1, 1],
    ["channel", "administrator", "administrator", false, 1, -1],
    ["group", "member", "administrator", false, 1087968824, -1],
    ["group", "administrator", "member", false, 1, -1],
    ["group", "administrator", "left", false, 1, -1],
    ["group", "administrator", "administrator", true, 1, -1],
  ] as const) {
    const f = fixture(type, role, bot, broken);
    t.after(f.d.close);
    await handleCommand(f.session(1, "/news on", chat, user));
    assert.equal((await f.c.news.group(String(chat))).enabled, 0);
  }
});
test("toggle callback generations and command update IDs prevent stale reactivation", async (t) => {
  const f = fixture();
  t.after(f.d.close);
  await handleCommand(f.session(10));
  await handleCommand(f.session(12, "/news off"));
  await handleCommand(f.session(11));
  await handleCallback(f.session(13, "", -1, 1, "news|on|1"));
  assert.equal((await f.c.news.group("-1")).enabled, 0);
  await handleCallback(f.session(14, "", -1, 1, "news|on|2"));
  assert.equal((await f.c.news.group("-1")).enabled, 1);
  await handleCommand(f.session(15, "/news"));
  assert.ok(f.methods.includes("getChatMember"));
});
test("anonymous sender_chat cannot mutate preferences even if a synthetic from matches an administrator", async (t) => {
  const f = fixture();
  t.after(f.d.close);
  const session = f.session(1);
  (session.message as any).sender_chat = { id: -1 };
  await handleCommand(session);
  assert.equal((await f.c.news.group("-1")).enabled, 0);
});
test("explicit off invalidates an older activation button even while already off", async (t) => {
  const f = fixture();
  t.after(f.d.close);
  await handleCommand(f.session(9, "/news"));
  await handleCommand(f.session(10, "/news off"));
  await handleCallback(f.session(11, "", -1, 1, "news|on|0"));
  assert.equal((await f.c.news.group("-1")).enabled, 0);
});
test("fresh lower update IDs after eight days work; old receipt and callback cannot undo shutdown", async (t) => {
  const f = fixture();
  t.after(f.d.close);
  await handleCommand(f.session(900000));
  const delayed = f.session(900001);
  f.time += 8 * 86400000;
  await handleCommand(f.session(10000, "/news off"));
  assert.equal((await f.c.news.group("-1")).enabled, 0);
  await handleCommand(delayed);
  await handleCallback(f.session(10001, "", -1, 1, "news|on|1"));
  assert.equal((await f.c.news.group("-1")).enabled, 0);
  await handleCallback(f.session(10002, "", -1, 1, "news|on|2"));
  assert.equal((await f.c.news.group("-1")).enabled, 1);
});
test("durable update receipt survives queue delay across an ID reset", async (t) => {
  const f = fixture();
  t.after(f.d.close);
  await handleCommand(f.session(900000));
  const old = f.session(900001);
  await f.c.updates.acceptUpdate(old.update, f.time);
  f.time += 8 * 86400000;
  const off = f.session(10000, "/news off");
  await f.c.updates.acceptUpdate(off.update, f.time);
  await processUpdate(10000, f.c, f.time);
  assert.equal((await f.c.news.group("-1")).enabled, 0);
  await processUpdate(900001, f.c, f.time);
  assert.equal((await f.c.news.group("-1")).enabled, 0);
});
