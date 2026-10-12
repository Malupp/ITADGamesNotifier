import type { ApplicationContext } from "./context.js";
import { NEWS_FEEDS } from "../infrastructure/news/sources.js";
import { NEWS_TTL } from "../domain/news.js";
import { ApiError } from "../infrastructure/http.js";
import { sendJobs } from "../runtime/queues.js";
import { html } from "../telegram/options.js";
export function newsEnabled(c: ApplicationContext) {
  return c.env.NEWS_ENABLED === "true" && c.env.SCANS_ENABLED !== "false";
}
export async function publishNews(c: ApplicationContext, now: number) {
  if (!newsEnabled(c)) return;
  const feeds = await c.newsJobs.dispatch(now);
  try {
    await sendJobs(
      c,
      feeds.map((id) => ({ kind: "newsfeed", id })),
    );
  } catch (error) {
    await c.newsJobs.releaseDispatch(feeds, now);
    throw error;
  }
  const deliveries = await c.news.dispatch(now);
  try {
    await sendJobs(
      c,
      deliveries.map((id) => ({ kind: "newsdelivery", id })),
    );
  } catch (error) {
    await c.news.releaseDispatch(deliveries, now);
    throw error;
  }
}
export async function scheduleNews(c: ApplicationContext, now: number) {
  if (!newsEnabled(c)) return;
  if ((await c.news.activeGroups()).length)
    await c.newsJobs.startCycle(
      NEWS_FEEDS.map((x) => x.id),
      now,
    );
  await publishNews(c, now);
  await c.news.prune(now);
}
export async function processNewsFeed(
  id: string,
  c: ApplicationContext,
  now: number,
): Promise<number | null> {
  if (!newsEnabled(c)) return null;
  const job = await c.newsJobs.claim(id, now);
  if (!job) return null;
  const token = job.lease_token!;
  const source = NEWS_FEEDS.find((x) => x.id === job.feed_id);
  const state = await c.news.feed(job.feed_id);
  let delay: number | null = null;
  if (
    source &&
    (await c.news.activeGroups()).length &&
    (!state || state.last_cycle < job.cycle_at)
  ) {
    let result;
    try {
      result = await c.newsFeeds.load(source, Math.max(now, c.now()), {
        etag: state?.etag,
        lastModified: state?.last_modified,
      });
    } catch {
      if (job.attempts < 5) {
        delay = Math.min(1800, 60 * 2 ** (job.attempts - 1));
        await c.newsJobs.retry(
          id,
          token,
          Math.max(now, c.now()) + delay * 1000,
          "feed_unavailable",
        );
      } else await c.newsJobs.complete(id, token, now);
    }
    if (result) {
      await c.news.ingest(source.id, result, Math.max(now, c.now()), job);
      await c.newsJobs.complete(id, token, now);
    }
  } else await c.newsJobs.complete(id, token, now);
  if (await c.newsJobs.cycleSettled(job.cycle_at))
    await c.news.queueForGroups(Math.max(now, c.now()));
  await publishNews(c, Math.max(now, c.now()));
  return delay;
}
export async function processNewsDelivery(
  id: string,
  c: ApplicationContext,
  now: number,
): Promise<number | null> {
  if (!newsEnabled(c)) return null;
  const delivery = await c.news.claimDelivery(id, now);
  if (!delivery) return null;
  const token = delivery.lease_token!;
  const article = await c.news.article(delivery.article_id);
  const group = await c.news.group(delivery.chat_id);
  const valid = (at: number) =>
    group.enabled === 1 &&
    group.generation === delivery.generation &&
    article !== null &&
    article.publishedAt > group.activated_at &&
    article.publishedAt > at - NEWS_TTL &&
    article.publishedAt <= at;
  if (!valid(now)) {
    await c.news.finishDelivery(id, token, "expired", now);
    return null;
  }
  try {
    const access = await c.telegram.getGroupAccess(delivery.chat_id);
    if (!access.isGroup || !access.botCanSend) {
      await c.news.disable(
        delivery.chat_id,
        Math.max(now, c.now()),
        delivery.generation,
      );
      return null;
    }
    const at = Math.max(now, c.now());
    if (!newsEnabled(c)) {
      await c.news.retryDelivery(id, token, at + 60000);
      return null;
    }
    if (!(await c.news.reserveAttempt(id, token, at))) {
      const latest = await c.news.group(delivery.chat_id);
      if (
        !latest.enabled ||
        latest.generation !== delivery.generation ||
        !valid(at)
      ) {
        await c.news.finishDelivery(id, token, "expired", at);
        return null;
      }
      const due = await c.news.nextAttemptAt(delivery.chat_id, at);
      await c.news.retryDelivery(id, token, due);
      return Math.max(1, Math.ceil((due - at) / 1000));
    }
    const label = {
      games: "🎮 Videogiochi",
      cinema: "🎬 Cinema",
      anime_manga: "🌸 Anime e manga",
    }[article!.topic];
    await c.telegram.sendMessage(
      delivery.chat_id,
      `${label}\n<b>${html(article!.title, 300)}</b>\n${html(article!.sourceName, 80)}\n<a href="${html(article!.url, 4000)}">Leggi la notizia</a>`,
    );
    await c.news.finishDelivery(id, token, "sent", Math.max(now, c.now()));
    return null;
  } catch (error) {
    if (error instanceof ApiError && error.permanent) {
      await c.news.disable(
        delivery.chat_id,
        Math.max(now, c.now()),
        delivery.generation,
      );
      return null;
    }
    const delay = Math.min(
      43200,
      Math.max(
        1,
        error instanceof ApiError && error.retryAfter
          ? error.retryAfter
          : Math.min(1800, 60 * 2 ** Math.min(delivery.attempts, 5)),
      ),
    );
    await c.news.retryDelivery(
      id,
      token,
      Math.max(now, c.now()) + delay * 1000,
    );
    return delay;
  }
}
