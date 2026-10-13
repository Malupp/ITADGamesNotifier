import { enrollPrivateUsers } from "../helpers/notifications.js";
import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/sqlite.js";
import { NewsRepository } from "../../src/infrastructure/d1/news.js";
import { NewsJobs } from "../../src/infrastructure/d1/news-jobs.js";
import type { NewsArticle } from "../../src/domain/news.js";
const now = 1791710000000;
const article = (id: string, at = now + 1000): NewsArticle => ({
  id,
  publisher: "test",
  sourceName: "Test",
  topic: "games",
  title: "Notizia",
  url: "https://multiplayer.it/" + id,
  publishedAt: at,
});
test("private toggles have defaults, cap, generations, update and callback replay protection", async (t) => {
  const d = testDatabase();
  t.after(d.close);
  await enrollPrivateUsers(d.db,Array.from({length:20},(_,i)=>String(i+1)),now);
  const r = new NewsRepository(d.db);
  assert.equal((await r.subscriber("1")).enabled, 0);
  assert.equal(await r.setEnabled("1", "private", true, now, 10), "ok");
  assert.equal(
    await r.setEnabled("1", "private", false, now + 1, 11),
    "ok",
  );
  assert.equal(
    await r.setEnabled("1", "private", true, now + 2, 10),
    "stale",
  );
  assert.equal(
    await r.setEnabled("1", "private", true, now + 2, 12, 1),
    "stale",
  );
  assert.equal((await r.subscriber("1")).enabled, 0);
  for (let i = 0; i < 10; i++)
    assert.equal(
      await r.setEnabled("" + (i + 2), "private", true, now, i + 20),
      "ok",
    );
  assert.equal(await r.setEnabled("20", "private", true, now, 100), "capacity");
  assert.equal((await r.activeSubscribers()).length, 10);
});
test("silent feed seed, activation boundary, TTL, off invalidation and new generation", async (t) => {
  const d = testDatabase();
  t.after(d.close);
  await enrollPrivateUsers(d.db,Array.from({length:20},(_,i)=>String(i+1)),now);
  const r = new NewsRepository(d.db);
  await r.setEnabled("1", "private", true, now, 1);
  await r.ingest(
    "feed",
    { articles: [article("seed")], notModified: false },
    now,
  );
  await r.queueForSubscribers(now + 2000);
  assert.equal((await r.dispatch(now + 2000)).length, 0);
  await r.ingest(
    "feed",
    {
      articles: [
        article("old", now - 1),
        article("new"),
        article("expired", now - 86400001),
      ],
      notModified: false,
    },
    now + 2000,
  );
  await r.queueForSubscribers(now + 2000);
  const [id] = await r.dispatch(now + 2000);
  assert.ok(id);
  assert.equal((await r.claimDelivery(id, now + 2000))?.article_id, "new");
  await r.setEnabled("1", "private", false, now + 3000, 2);
  assert.equal(
    await r.reserveAttempt(
      id,
      (await r.delivery(id))!.lease_token!,
      now + 3000,
    ),
    false,
  );
  await r.setEnabled("1", "private", true, now + 4000, 3);
  await r.queueForSubscribers(now + 5000);
  assert.deepEqual(await r.dispatch(now + 5000), []);
});
test("atomic rolling budget includes retries and isolated subscribers; stale lease cannot finish", async (t) => {
  const d = testDatabase();
  t.after(d.close);
  await enrollPrivateUsers(d.db,Array.from({length:20},(_,i)=>String(i+1)),now);
  const r = new NewsRepository(d.db);
  await r.setEnabled("1", "private", true, now, 1);
  await r.setEnabled("2", "private", true, now, 2);
  await r.ingest("feed", { articles: [], notModified: false }, now);
  await r.ingest(
    "feed",
    {
      articles: ["a", "b", "c", "d"].map((x) => article(x)),
      notModified: false,
    },
    now + 2000,
  );
  await r.queueForSubscribers(now + 2000);
  const ids = await r.dispatch(now + 2000);
  const rows = (
    await Promise.all(ids.map((x) => r.claimDelivery(x, now + 2000)))
  ).filter((x) => x?.chat_id === "1");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    await Promise.all(
      rows.map((x) => r.reserveAttempt(x!.id, x!.lease_token!, now + 2000)),
    ),
    [true, true, true],
  );
  const row = rows[0]!;
  await r.retryDelivery(row.id, row.lease_token!, now + 3000);
  const retry = (await r.claimDelivery(row.id, now + 3000))!;
  assert.equal(
    await r.reserveAttempt(row.id, retry.lease_token!, now + 3000),
    false,
  );
  await r.finishDelivery(row.id, row.lease_token!, "sent", now + 3000);
  assert.equal((await r.delivery(row.id))?.status, "processing");
  const later = (await r.claimDelivery(row.id, now + 3602000))!;
  assert.equal(
    await r.reserveAttempt(row.id, later.lease_token!, now + 3602000),
    true,
  );
  const other = (await r.delivery(
    ids.find((x) => !rows.some((y) => y?.id === x))!,
  ))!;
  assert.equal(
    await r.reserveAttempt(other.id, other.lease_token!, now + 3000),
    true,
  );
});
test("durable feed jobs dedup cycles, recover dispatch and leases; failed feed does not block selection", async (t) => {
  const d = testDatabase();
  t.after(d.close);
  await enrollPrivateUsers(d.db,Array.from({length:20},(_,i)=>String(i+1)),now);
  const jobs = new NewsJobs(d.db);
  await jobs.startCycle(["a", "b"], now);
  await jobs.startCycle(["a", "b"], now);
  const ids = await jobs.dispatch(now);
  assert.equal(ids.length, 2);
  await jobs.releaseDispatch(ids, now);
  assert.equal((await jobs.dispatch(now)).length, 2);
  const a = (await jobs.claim(ids[0], now))!;
  assert.ok(a);
  assert.equal(await jobs.claim(ids[0], now), null);
  assert.equal(
    await jobs.cycleSettled(Math.floor(now / 1800000) * 1800000),
    false,
  );
  await jobs.complete(a.id, a.lease_token!, now);
  const b = (await jobs.claim(ids[1], now))!;
  await jobs.retry(b.id, b.lease_token!, now + 1000, "feed_failure");
  assert.equal(await jobs.cycleSettled(now), true);
  const next = (await jobs.claim(b.id, now + 1000))!;
  await jobs.complete(b.id, b.lease_token!, now + 1000);
  assert.equal((await jobs.get(b.id))?.status, "processing");
  await jobs.complete(b.id, next.lease_token!, now + 1000);
});
test("an older settled cycle cannot select articles from an unsettled newer cycle", async (t) => {
  const d = testDatabase();
  t.after(d.close);
  await enrollPrivateUsers(d.db,Array.from({length:20},(_,i)=>String(i+1)),now);
  const r = new NewsRepository(d.db),
    jobs = new NewsJobs(d.db);
  await r.setEnabled("1", "private", true, now, 1);
  await r.ingest("a", { articles: [], notModified: false }, now);
  const later = Math.floor(now / 1800000) * 1800000 + 1800000;
  await jobs.startCycle(["a", "b"], later);
  const ids = await jobs.dispatch(later);
  const a = (await jobs.claim(ids.find((x) => x.startsWith("a:"))!, later))!;
  await r.ingest(
    "a",
    { articles: [article("future-cycle", later + 1000)], notModified: false },
    later + 2000,
    a,
  );
  await jobs.complete(a.id, a.lease_token!, later + 2000);
  await r.queueForSubscribers(later + 2000);
  assert.deepEqual(await r.dispatch(later + 2000), []);
  const b = (await jobs.claim(
    ids.find((x) => x.startsWith("b:"))!,
    later + 2000,
  ))!;
  await jobs.complete(b.id, b.lease_token!, later + 2000);
  await r.queueForSubscribers(later + 2000);
  assert.equal((await r.dispatch(later + 2000)).length, 1);
});
