import { enrollPrivateUsers } from "../helpers/notifications.js";
import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/sqlite.js";
import { createContext } from "../../src/application/context.js";
import {
  scheduleNews,
  processNewsFeed,
  processNewsDelivery,
  publishNews,
} from "../../src/application/news.js";
import { processJob } from "../../src/runtime/consumer.js";
import { enqueueTick } from "../../src/runtime/queues.js";
import { NEWS_FEEDS } from "../../src/infrastructure/news/sources.js";
import type { Env, QueueJob } from "../../src/runtime/bindings.js";
function fixture() {
  const d = testDatabase();
  let time = Date.parse("2026-10-11T12:00:00Z"),
    phase = 0,
    failQueue = false,
    failFeed = false,
    botRole = "administrator",
    sendStatus = 200;
  const jobs: QueueJob[] = [],
    requests: string[] = [],
    sends: any[] = [];
  const urls = [
    "https://multiplayer.it/notizie/game",
    "https://www.everyeye.it/notizie/game",
    "https://www.comingsoon.it/cinema/news/movie",
    "https://cinema.everyeye.it/notizie/movie",
    "https://cinefilos.it/cinema-news/2026/movie",
    "https://www.mangaforever.net/manga",
    "https://anime.everyeye.it/notizie/anime",
    "https://www.akibagamers.it/anime",
  ];
  const cats = [
    "News",
    "Steam",
    "Cinema",
    "Film",
    "2026",
    "News Anime",
    "One Piece",
    "Notizie Anime e Manga",
  ];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push(String(url));
    if (String(url).startsWith("https://api.telegram.org/")) {
      const method = String(url).split("/").at(-1),
        body = JSON.parse(String(init?.body));
      if (method === "sendMessage") {
        sends.push(body);
        return Response.json(
          sendStatus === 200
            ? { ok: true, result: {} }
            : {
                ok: false,
                error_code: sendStatus,
                parameters: { retry_after: 1 },
              },
          { status: sendStatus },
        );
      }
      return Response.json({
        ok: true,
        result:
          method === "getMe"
            ? { id: 99, is_bot: true }
            : method === "getChat"
              ? { id: Number(body.chat_id), type: "private" }
              : { user: { id: body.user_id }, status: botRole },
      });
    }
    const i = NEWS_FEEDS.findIndex((x) => x.url === String(url));
    assert.ok(i >= 0);
    if (failFeed && i === 0) return new Response("broken", { status: 503 });
    return new Response(
      `<rss><channel><language>it-IT</language><item><title>Notizia &amp; novità ${phase}</title><link>${urls[i]}-${phase}</link><category>${cats[i]}</category><pubDate>${new Date(time - 1000).toUTCString()}</pubDate></item></channel></rss>`,
    );
  };
  const queue = {
    sendBatch: async (items: any[]) => {
      if (failQueue) throw Error("queue");
      jobs.push(...items.map((x) => x.body));
    },
    send: async (job: QueueJob) => {
      jobs.push(job);
    },
  };
  const env = {
    DB: d.db,
    WORK_QUEUE: queue,
    TELEGRAM_BOT_TOKEN: "fake",
    ITAD_API_KEY: "",
    TELEGRAM_WEBHOOK_SECRET: "",
    NEWS_ENABLED: "true",
    SCANS_ENABLED: "true",
  } as unknown as Env;
  const c = createContext(env, { fetcher, now: () => time });
  async function cycle() {
    await scheduleNews(c, time);
    while (jobs.length) {
      const job = jobs.shift()!;
      if (job.kind === "newsfeed") await processNewsFeed(job.id, c, time);
      else if (job.kind === "newsdelivery")
        await processNewsDelivery(job.id, c, time);
    }
  }
  return {
    d,
    c,
    jobs,
    requests,
    sends,
    cycle,
    get time() {
      return time;
    },
    advance() {
      time += 1800000;
      phase++;
    },
    set queueFails(v: boolean) {
      failQueue = v;
    },
    set feedFails(v: boolean) {
      failFeed = v;
    },
    set bot(v: string) {
      botRole = v;
    },
    set sendCode(v: number) {
      sendStatus = v;
    },
  };
}
test("no feed fetch when disabled or zero subscribers; cron includes news only when enabled", async (t) => {
  const f = fixture();
  t.after(f.d.close);
  await enrollPrivateUsers(f.d.db,Array.from({length:10},(_,i)=>String(i+1)),f.time-10000);
  await f.cycle();
  assert.equal(f.requests.length, 0);
  await f.c.news.setEnabled("1", "private", true, f.time - 10000, 1);
  f.c.env.NEWS_ENABLED = "false";
  await f.cycle();
  assert.equal(f.requests.length, 0);
  await enqueueTick(f.c, f.time);
  assert.ok(!f.jobs.some((x) => x.kind === "tick" && x.part === "news"));
  f.jobs.length = 0;
  f.c.env.NEWS_ENABLED = "true";
  await enqueueTick(f.c, f.time);
  assert.ok(f.jobs.some((x) => x.kind === "tick" && x.part === "news"));
});
test("silent first cycle; next cycle balances three areas, deduplicates and caps each subscriber", async (t) => {
  const f = fixture();
  t.after(f.d.close);
  await enrollPrivateUsers(f.d.db,Array.from({length:10},(_,i)=>String(i+1)),f.time-10000);
  await f.c.news.setEnabled("1", "private", true, f.time - 10000, 1);
  await f.cycle();
  assert.equal(f.sends.length, 0);
  assert.equal(f.requests.length, 8);
  f.advance();
  await f.cycle();
  assert.equal(f.sends.length, 3);
  assert.ok(f.sends.some((x) => x.text.includes("Videogiochi")));
  assert.ok(f.sends.some((x) => x.text.includes("Cinema")));
  assert.ok(f.sends.some((x) => x.text.includes("Anime e manga")));
  assert.ok(
    f.sends.every(
      (x) => x.chat_id === "1" && x.text.includes("Leggi la notizia"),
    ),
  );
  f.advance();
  await f.cycle();
  assert.equal(f.sends.length, 3);
});
test("off, global pause and blocking prevent pending sends", async (t) => {
  for (const change of ["off", "pause", "blocked"]) {
    const f = fixture();
    t.after(f.d.close);
  await enrollPrivateUsers(f.d.db,Array.from({length:10},(_,i)=>String(i+1)),f.time-10000);
    await f.c.news.setEnabled("1", "private", true, f.time - 10000, 1);
    await f.cycle();
    f.advance();
    await f.c.news.ingest(
      "multiplayer",
      {
        articles: [
          {
            id: "a",
            publisher: "test",
            sourceName: "Test",
            topic: "games",
            title: "Title",
            url: "https://multiplayer.it/a",
            publishedAt: f.time - 1000,
          },
        ],
        notModified: false,
      },
      f.time,
    );
    await f.c.news.queueForSubscribers(f.time);
    const [id] = await f.c.news.dispatch(f.time);
    assert.ok(id);
    if (change === "off")
      await f.c.news.setEnabled("1", "private", false, f.time, 2);
    if (change === "pause") f.c.env.NEWS_ENABLED = "false";
    if (change === "blocked") await f.c.env.DB.prepare("INSERT INTO blocked_chats(chat_id,blocked_at) VALUES(?,?)").bind("1",f.time).run();
    await processJob({ kind: "newsdelivery", id }, f.c, f.time);
    assert.equal(f.sends.length, 0);
    if (change === "blocked") assert.equal((await f.c.news.activeSubscribers()).length, 0);
  }
});
test("429 retry consumes budget; queue publication failure remains recoverable", async (t) => {
  const f = fixture();
  t.after(f.d.close);
  await enrollPrivateUsers(f.d.db,Array.from({length:10},(_,i)=>String(i+1)),f.time-10000);
  await f.c.news.setEnabled("1", "private", true, f.time - 10000, 1);
  await f.cycle();
  f.advance();
  await f.c.news.ingest(
    "multiplayer",
    {
      articles: [
        {
          id: "a",
          publisher: "test",
          sourceName: "Test",
          topic: "games",
          title: "Title",
          url: "https://multiplayer.it/a",
          publishedAt: f.time - 1000,
        },
      ],
      notModified: false,
    },
    f.time,
  );
  await f.c.news.queueForSubscribers(f.time);
  f.queueFails = true;
  await assert.rejects(publishNews(f.c, f.time));
  f.queueFails = false;
  await publishNews(f.c, f.time);
  const job = f.jobs.find((x) => x.kind === "newsdelivery")!;
  f.jobs.length = 0;
  assert.ok(job);
  f.sendCode = 429;
  for (let i = 0; i < 3; i++) {
    await processJob(job, f.c, f.time + 2000 * i);
  }
  await processJob(job, f.c, f.time + 10000);
  assert.equal(f.sends.length, 3);
  assert.equal(
    f.d.sqlite.prepare("SELECT count(*) n FROM news_send_attempts").get()!.n,
    3,
  );
});
test("one broken source does not block other publishers and feed dispatch recovers", async (t) => {
  const f = fixture();
  t.after(f.d.close);
  await enrollPrivateUsers(f.d.db,Array.from({length:10},(_,i)=>String(i+1)),f.time-10000);
  await f.c.news.setEnabled("1", "private", true, f.time - 10000, 1);
  await f.cycle();
  f.advance();
  f.feedFails = true;
  f.queueFails = true;
  await assert.rejects(scheduleNews(f.c, f.time));
  f.queueFails = false;
  await f.cycle();
  assert.equal(f.sends.length, 3);
});
test("ten-subscriber feed processing stays below fifty D1 queries per invocation", async (t) => {
  const f = fixture();
  t.after(f.d.close);
  await enrollPrivateUsers(f.d.db,Array.from({length:10},(_,i)=>String(i+1)),f.time-10000);
  for (let i = 1; i <= 10; i++)
    await f.c.news.setEnabled("" + i, "private", true, f.time - 10000, i);
  await f.cycle();
  f.advance();
  await scheduleNews(f.c, f.time);
  const original = f.c.env.DB.prepare.bind(f.c.env.DB);
  let count = 0;
  f.c.env.DB.prepare = (sql: string) => {
    count++;
    return original(sql);
  };
  const feeds = f.jobs.filter((x) => x.kind === "newsfeed");
  f.jobs.length = 0;
  for (const job of feeds) {
    count = 0;
    await processJob(job, f.c, f.time);
    assert.ok(count <= 50, `D1 queries: ${count}`);
  }
  assert.equal(
    f.d.sqlite
      .prepare("SELECT count(*) n FROM news_deliveries WHERE status='pending'")
      .get()!.n,
    30,
  );
});
