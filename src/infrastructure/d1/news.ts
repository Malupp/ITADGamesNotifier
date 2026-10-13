import {
  NEWS_TTL,
  NEWS_WINDOW,
  selectNews,
  type NewsArticle,
} from "../../domain/news.js";
import type { FeedResult } from "../news/client.js";
import { NEWS_LEASE, type NewsJob } from "./news-jobs.js";
export interface NewsSubscriber {
  chat_id: string;
  chat_type: "private";
  enabled: number;
  activated_at: number;
  generation: number;
  revision: number;
  last_update_id: number;
  last_received_at: number;
  topic_cursor: number;
  source_cursors: string;
}
export interface NewsDelivery {
  id: string;
  chat_id: string;
  article_id: string;
  generation: number;
  status: string;
  due_at: number;
  lease_token: string | null;
  lease_until: number | null;
  attempts: number;
  media_failed: number;
}
export interface NewsFeedState {
  id: string;
  seeded: number;
  etag: string | null;
  last_modified: string | null;
  last_cycle: number;
}
export class NewsRepository {
  constructor(private db: D1Database) {}
  async subscriber(chatId: string): Promise<NewsSubscriber> {
    return (
      (await this.db
        .prepare("SELECT * FROM news_subscribers WHERE chat_id=?")
        .bind(chatId)
        .first<NewsSubscriber>()) ?? {
        chat_id: chatId,
        chat_type: "private",
        enabled: 0,
        activated_at: 0,
        generation: 0,
        revision: 0,
        last_update_id: -1,
        last_received_at: 0,
        topic_cursor: 0,
        source_cursors: "{}",
      }
    );
  }
  async setEnabled(
    chatId: string,
    type: "private",
    on: boolean,
    now: number,
    updateId: number,
    expected?: number,
    receivedAt = now,
  ): Promise<"ok" | "stale" | "capacity"> {
    if (type !== "private" || !/^[1-9]\d*$/.test(chatId)) return "stale";
    if (!(await this.db.prepare("SELECT 1 FROM private_users WHERE user_id=?").bind(chatId).first())) return "stale";
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO news_subscribers(chat_id,chat_type,updated_at) VALUES(?,?,?)",
      )
      .bind(chatId, type, now)
      .run();
    const row = await this.db
      .prepare(
        `UPDATE news_subscribers SET enabled=?,chat_type=?,generation=generation+CASE WHEN enabled!=? THEN 1 ELSE 0 END,
      activated_at=CASE WHEN enabled=0 AND ?=1 THEN ? ELSE activated_at END,last_update_id=?,updated_at=?,revision=revision+1,last_received_at=?
      WHERE chat_id=? AND ? >= last_received_at AND ? >= ?
      AND (last_update_id<? OR ?>last_received_at+604800000) AND (? IS NULL OR revision=?)
      AND (?=0 OR enabled=1 OR (SELECT count(*) FROM news_subscribers s WHERE s.enabled=1
        AND EXISTS(SELECT 1 FROM private_users u WHERE u.user_id=s.chat_id)
        AND NOT EXISTS(SELECT 1 FROM blocked_chats b WHERE b.chat_id=s.chat_id))<10) RETURNING *`,
      )
      .bind(
        Number(on),
        type,
        Number(on),
        Number(on),
        now,
        updateId,
        now,
        receivedAt,
        chatId,
        receivedAt,
        receivedAt,
        now - NEWS_TTL,
        updateId,
        receivedAt,
        expected ?? null,
        expected ?? null,
        Number(on),
      )
      .first<NewsSubscriber>();
    if (!row) {
      const subscriber = await this.subscriber(chatId);
      return receivedAt < subscriber.last_received_at ||
        receivedAt < now - NEWS_TTL ||
        (subscriber.last_update_id >= updateId &&
          receivedAt <= subscriber.last_received_at + 7 * NEWS_TTL) ||
        (expected !== undefined && subscriber.revision !== expected)
        ? "stale"
        : "capacity";
    }
    if (!on)
      await this.db
        .prepare(
          "UPDATE news_deliveries SET status='expired',lease_token=NULL,lease_until=NULL WHERE chat_id=? AND generation<=? AND status IN ('pending','processing')",
        )
        .bind(chatId, row.generation)
        .run();
    return "ok";
  }
  async disable(chatId: string, now: number, generation: number) {
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE news_subscribers SET enabled=0,generation=generation+1,revision=revision+1,updated_at=? WHERE chat_id=? AND generation=? AND enabled=1",
        )
        .bind(now, chatId, generation),
      this.db
        .prepare(
          "UPDATE news_deliveries SET status='expired',lease_token=NULL WHERE chat_id=? AND generation=? AND status IN ('pending','processing')",
        )
        .bind(chatId, generation),
    ]);
  }
  async failDelivery(
    delivery: NewsDelivery, token: string, revision: number,
    activity: number | null, now: number, blocked: boolean, attemptedAt = now,
  ) {
    const current = `EXISTS(SELECT 1 FROM news_deliveries d
      JOIN news_subscribers s ON s.chat_id=d.chat_id
      JOIN private_users u ON u.user_id=d.chat_id
      WHERE d.id=? AND d.status='processing' AND d.lease_token=? AND d.lease_until>?
      AND s.enabled=1 AND s.generation=d.generation AND s.revision=? AND u.activity_revision IS ?)`;
    const guard = [delivery.id, token, now, revision, activity];
    await this.db.batch([
      this.db.prepare(`INSERT INTO blocked_chats(chat_id,blocked_at)
        SELECT ?,? WHERE ?=1 AND ${current}
        ON CONFLICT(chat_id) DO UPDATE SET blocked_at=MAX(blocked_chats.blocked_at,excluded.blocked_at)`)
        .bind(delivery.chat_id, attemptedAt, Number(blocked), ...guard),
      this.db.prepare(`UPDATE news_subscribers SET enabled=0,generation=generation+1,
        revision=revision+1,updated_at=? WHERE chat_id=? AND ${current}`)
        .bind(now, delivery.chat_id, ...guard),
      this.db.prepare(`UPDATE news_deliveries SET status='expired',lease_token=NULL,lease_until=NULL
        WHERE chat_id=? AND generation=? AND status IN ('pending','processing')
        AND EXISTS(SELECT 1 FROM news_subscribers s JOIN private_users u ON u.user_id=s.chat_id
          WHERE s.chat_id=? AND s.enabled=0 AND s.generation=? AND s.revision=? AND s.updated_at=?
          AND u.activity_revision IS ?)`)
        .bind(delivery.chat_id, delivery.generation, delivery.chat_id,
          delivery.generation + 1, revision + 1, now, activity),
    ]);
    // A newer command/claim owns the subscription now. Retire only our own failed delivery.
    await this.finishDelivery(delivery.id, token, "expired", now);
  }
  async activeSubscribers() {
    return (
      await this.db
        .prepare(
          "SELECT * FROM news_subscribers WHERE enabled=1 AND EXISTS(SELECT 1 FROM private_users WHERE user_id=chat_id) AND NOT EXISTS(SELECT 1 FROM blocked_chats WHERE blocked_chats.chat_id=news_subscribers.chat_id) ORDER BY chat_id LIMIT 10",
        )
        .all<NewsSubscriber>()
    ).results;
  }
  feed(id: string) {
    return this.db
      .prepare("SELECT * FROM news_feeds WHERE id=?")
      .bind(id)
      .first<NewsFeedState>();
  }
  async ingest(feedId: string, result: FeedResult, now: number, job?: NewsJob) {
    const guard = job
      ? "EXISTS(SELECT 1 FROM news_jobs WHERE id=? AND lease_token=? AND status='processing' AND lease_until>?) AND NOT EXISTS(SELECT 1 FROM news_feeds WHERE id=? AND last_cycle>?)"
      : "1";
    const values = job
      ? [job.id, job.lease_token, now, feedId, job.cycle_at]
      : [];
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO news_articles(id,publisher,source_name,topic,title,url,published_at,eligible,discovered_at,guid,cycle_at,summary,image_url)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.publisher'),json_extract(value,'$.sourceName'),json_extract(value,'$.topic'),
        json_extract(value,'$.title'),json_extract(value,'$.url'),json_extract(value,'$.publishedAt'),
        COALESCE((SELECT seeded FROM news_feeds WHERE id=?),0),?,json_extract(value,'$.guid'),?,json_extract(value,'$.summary'),json_extract(value,'$.imageUrl') FROM json_each(?) WHERE ${guard}`,
        )
        .bind(
          feedId,
          now,
          job?.cycle_at ?? 0,
          JSON.stringify(result.articles),
          ...values,
        ),
      this.db
        .prepare(
          `INSERT INTO news_feeds(id,seeded,etag,last_modified,fetched_at,last_cycle)
        SELECT ?,1,?,?,?,? WHERE ${guard} ON CONFLICT(id) DO UPDATE SET seeded=1,etag=excluded.etag,last_modified=excluded.last_modified,
        fetched_at=excluded.fetched_at,last_cycle=excluded.last_cycle`,
        )
        .bind(
          feedId,
          result.etag ?? null,
          result.lastModified ?? null,
          now,
          job?.cycle_at ?? now,
          ...values,
        ),
    ]);
  }
  async queueForSubscribers(now: number) {
    for (const subscriber of await this.activeSubscribers()) {
      const rows = await this.db
        .prepare(
          `WITH backlog AS (SELECT count(*) AS n FROM news_deliveries WHERE chat_id=? AND status IN ('pending','processing')) SELECT *, (SELECT n FROM backlog) AS outstanding FROM (
        SELECT a.*,row_number() OVER(PARTITION BY topic,publisher ORDER BY published_at DESC,id) AS rank FROM news_articles a
        WHERE (SELECT n FROM backlog)<3 AND eligible=1 AND published_at>? AND published_at>? AND published_at<=?
        AND (cycle_at=0 OR NOT EXISTS(SELECT 1 FROM news_jobs j WHERE j.cycle_at=a.cycle_at AND (j.attempts=0 OR j.status='processing')))
        AND NOT EXISTS(SELECT 1 FROM news_deliveries d WHERE d.chat_id=? AND d.article_id=a.id)) WHERE rank<=3`,
        )
        .bind(
          subscriber.chat_id,
          subscriber.activated_at,
          now - NEWS_TTL,
          now,
          subscriber.chat_id,
        )
        .all<any>();
      const count = Math.max(0, 3 - (rows.results[0]?.outstanding ?? 3));
      const candidates: NewsArticle[] = rows.results.map((x) => ({
        id: x.id,
        publisher: x.publisher,
        sourceName: x.source_name,
        topic: x.topic,
        title: x.title,
        url: x.url,
        publishedAt: x.published_at,
        summary: x.summary,
        imageUrl: x.image_url,
      }));
      const selection = selectNews(
        candidates,
        count,
        subscriber.topic_cursor,
        JSON.parse(subscriber.source_cursors),
      );
      if (!selection.articles.length) continue;
      await this.db.batch([
        this.db
          .prepare(
            `INSERT OR IGNORE INTO news_deliveries(id,chat_id,article_id,generation,due_at)
          SELECT ? || ':' || value,?,value,?,? FROM json_each(?)
          WHERE EXISTS(SELECT 1 FROM news_subscribers WHERE chat_id=? AND enabled=1 AND generation=?)
          LIMIT max(0,3-(SELECT count(*) FROM news_deliveries WHERE chat_id=? AND status IN ('pending','processing')))`,
          )
          .bind(
            subscriber.chat_id,
            subscriber.chat_id,
            subscriber.generation,
            now,
            JSON.stringify(selection.articles.map((x) => x.id)),
            subscriber.chat_id,
            subscriber.generation,
            subscriber.chat_id,
          ),
        this.db
          .prepare(
            "UPDATE news_subscribers SET topic_cursor=?,source_cursors=? WHERE chat_id=? AND generation=? AND enabled=1",
          )
          .bind(
            selection.cursor,
            JSON.stringify(selection.publishers),
            subscriber.chat_id,
            subscriber.generation,
          ),
      ]);
    }
  }
  delivery(id: string) {
    return this.db
      .prepare("SELECT * FROM news_deliveries WHERE id=?")
      .bind(id)
      .first<NewsDelivery>();
  }
  article(id: string) {
    return this.db
      .prepare(
        "SELECT id,publisher,source_name AS sourceName,topic,title,url,published_at AS publishedAt,guid,summary,image_url AS imageUrl FROM news_articles WHERE id=?",
      )
      .bind(id)
      .first<NewsArticle>();
  }
  async dispatch(now: number) {
    await this.db
      .prepare(
        `UPDATE news_deliveries SET status='expired',lease_token=NULL WHERE status IN ('pending','processing') AND
      (NOT EXISTS(SELECT 1 FROM news_subscribers g WHERE g.chat_id=news_deliveries.chat_id AND g.enabled=1 AND g.generation=news_deliveries.generation)
      OR NOT EXISTS(SELECT 1 FROM private_users u WHERE u.user_id=news_deliveries.chat_id)
      OR EXISTS(SELECT 1 FROM blocked_chats b WHERE b.chat_id=news_deliveries.chat_id)
      OR NOT EXISTS(SELECT 1 FROM news_articles a WHERE a.id=news_deliveries.article_id AND a.published_at>?))`,
      )
      .bind(now - NEWS_TTL)
      .run();
    return (
      await this.db
        .prepare(
          `UPDATE news_deliveries SET enqueued_at=? WHERE id IN (SELECT id FROM news_deliveries
      WHERE ((status='pending' AND due_at<=?) OR (status='processing' AND lease_until<=?))
      AND (enqueued_at IS NULL OR enqueued_at<=?) ORDER BY due_at LIMIT 20) RETURNING id`,
        )
        .bind(now, now, now, now - NEWS_LEASE)
        .all<{ id: string }>()
    ).results.map((x) => x.id);
  }
  async releaseDispatch(ids: string[], now: number) {
    await this.db
      .prepare(
        "UPDATE news_deliveries SET enqueued_at=NULL WHERE id IN (SELECT value FROM json_each(?)) AND enqueued_at=?",
      )
      .bind(JSON.stringify(ids), now)
      .run();
  }
  claimDelivery(id: string, now: number) {
    return this.db
      .prepare(
        `UPDATE news_deliveries SET status='processing',lease_token=?,lease_until=? WHERE id=? AND due_at<=?
      AND (status='pending' OR (status='processing' AND lease_until<=?)) RETURNING *`,
      )
      .bind(crypto.randomUUID(), now + NEWS_LEASE, id, now, now)
      .first<NewsDelivery>();
  }
  async reserveAttempt(id: string, token: string, now: number) {
    const result = await this.db
      .prepare(
        `INSERT INTO news_send_attempts(chat_id,delivery_id,started_at)
      SELECT d.chat_id,d.id,? FROM news_deliveries d JOIN news_subscribers g ON g.chat_id=d.chat_id JOIN news_articles a ON a.id=d.article_id
      WHERE d.id=? AND d.status='processing' AND d.lease_token=? AND d.lease_until>?
      AND g.enabled=1 AND g.generation=d.generation AND EXISTS(SELECT 1 FROM private_users WHERE user_id=d.chat_id) AND NOT EXISTS(SELECT 1 FROM blocked_chats WHERE chat_id=d.chat_id) AND a.published_at>g.activated_at AND a.published_at>? AND a.published_at<=?
      AND (SELECT count(*) FROM news_send_attempts WHERE chat_id=d.chat_id AND started_at>?)<3`,
      )
      .bind(now, id, token, now, now - NEWS_TTL, now, now - NEWS_WINDOW)
      .run();
    return result.meta.changes === 1;
  }
  async nextAttemptAt(chatId: string, now: number) {
    const row = await this.db
      .prepare(
        "SELECT min(started_at) AS at FROM news_send_attempts WHERE chat_id=? AND started_at>?",
      )
      .bind(chatId, now - NEWS_WINDOW)
      .first<{ at: number | null }>();
    return row?.at === null || !row ? now + 60000 : row.at + NEWS_WINDOW + 1;
  }
  async finishDelivery(
    id: string,
    token: string,
    status: "sent" | "expired",
    now: number,
  ) {
    await this.db
      .prepare(
        "UPDATE news_deliveries SET status=?,sent_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='processing'",
      )
      .bind(status, status === "sent" ? now : null, id, token)
      .run();
  }
  async retryDelivery(id: string, token: string, due: number, mediaFailed = false) {
    await this.db
      .prepare(
        "UPDATE news_deliveries SET status='pending',due_at=?,media_failed=MAX(media_failed,?),attempts=attempts+1,enqueued_at=NULL,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='processing'",
      )
      .bind(due, Number(mediaFailed), id, token)
      .run();
  }
  async prune(now: number) {
    await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM news_send_attempts WHERE id IN (SELECT id FROM news_send_attempts WHERE started_at<? LIMIT 100)",
        )
        .bind(now - NEWS_TTL),
      this.db
        .prepare(
          "DELETE FROM news_jobs WHERE id IN (SELECT id FROM news_jobs WHERE status='done' AND cycle_at<? LIMIT 100)",
        )
        .bind(now - 7 * NEWS_TTL),
      this.db
        .prepare(
          "DELETE FROM news_deliveries WHERE id IN (SELECT id FROM news_deliveries WHERE status IN ('sent','expired') AND due_at<? LIMIT 100)",
        )
        .bind(now - 7 * NEWS_TTL),
      this.db
        .prepare(
          "DELETE FROM news_articles WHERE id IN (SELECT id FROM news_articles WHERE published_at<? AND NOT EXISTS(SELECT 1 FROM news_deliveries WHERE article_id=news_articles.id) LIMIT 100)",
        )
        .bind(now - 7 * NEWS_TTL),
    ]);
  }
}
