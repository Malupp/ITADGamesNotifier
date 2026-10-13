import { plainText, imageUrl } from "../content.js";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { NEWS_TTL, type NewsArticle } from "../../domain/news.js";
import { articleTopic, type NewsFeed } from "./sources.js";
export interface FeedCache {
  etag?: string | null;
  lastModified?: string | null;
}
export interface FeedResult extends FeedCache {
  articles: NewsArticle[];
  notModified: boolean;
}
const LIMIT = 512 * 1024;
const array = (value: any): any[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: any): string =>
  typeof value === "string"
    ? value
    : typeof value?.["#text"] === "string"
      ? value["#text"]
      : "";
function feedImage(item: any): string | null {
  const candidates = [
    ...array(item["media:content"]).filter(x => !x["@_medium"] || x["@_medium"] === "image").map(x => x["@_url"]),
    ...array(item["media:thumbnail"]).map(x => x["@_url"]),
    ...array(item.enclosure).filter(x => /^image\//.test(x["@_type"] ?? "")).map(x => x["@_url"]),
  ];
  const content = text(item.description) + " " + text(item["content:encoded"]);
  const match = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(content);
  if (match) candidates.push(match[1].replace(/&amp;/g,"&"));
  for (const candidate of candidates) {
    const url = imageUrl(candidate);
    if (url) return url;
  }
  return null;
}
export class NewsFeedClient {
  constructor(private fetcher: typeof fetch = fetch) {}
  async load(
    feed: NewsFeed,
    now: number,
    cache: FeedCache = {},
  ): Promise<FeedResult> {
    try {
      // Native Workers fetch rejects a NewsFeedClient instance as its receiver.
      const fetcher = this.fetcher;
      const response = await fetcher(feed.url, {
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml",
          ...(cache.etag ? { "If-None-Match": cache.etag } : {}),
          ...(cache.lastModified
            ? { "If-Modified-Since": cache.lastModified }
            : {}),
        },
      });
      if (response.status === 304)
        return { articles: [], notModified: true, ...cache };
      if (
        !response.ok ||
        Number(response.headers.get("content-length")) > LIMIT
      )
        throw Error("response");
      const reader = response.body?.getReader();
      if (!reader) throw Error("body");
      let size = 0;
      const parts: Uint8Array[] = [];
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > LIMIT) throw Error("size");
          parts.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      const xml = new TextDecoder().decode(bytes);
      if (
        /<!\s*(DOCTYPE|ENTITY)/i.test(xml) ||
        XMLValidator.validate(xml) !== true
      )
        throw Error("xml");
      const channel = new XMLParser({
        ignoreAttributes: false,
        parseTagValue: false,
        trimValues: true,
      }).parse(xml)?.rss?.channel;
      if (!channel || Array.isArray(channel)) throw Error("rss");
      const language = text(channel.language).toLowerCase();
      const articles: NewsArticle[] = [];
      if (!language || /^it(?:[-_]|$)/.test(language))
        for (const item of array(channel.item).slice(0, 50)) {
          let url: URL;
          try {
            url = new URL(text(item.link));
          } catch {
            continue;
          }
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.port ||
            url.hostname !== feed.host
          )
            continue;
          const topic = articleTopic(feed, url, array(item.category).map(text));
          if (!topic) continue;
          const publishedAt = Date.parse(text(item.pubDate));
          if (
            !Number.isFinite(publishedAt) ||
            publishedAt > now + 300000 ||
            publishedAt <= now - NEWS_TTL
          )
            continue;
          url.hash = "";
          for (const key of [...url.searchParams.keys()])
            if (/^utm_|^(fbclid|gclid)$/i.test(key))
              url.searchParams.delete(key);
          url.searchParams.sort();
          const escapedUrl = url.href
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          if (escapedUrl.length > 2048) continue;
          const title = plainText(text(item.title), 200);
          if (
            !title ||
            !articleTopic(feed, url, array(item.category).map(text), title)
          )
            continue;
          const hash = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(feed.publisher + "\n" + url.href),
          );
          const id = Array.from(new Uint8Array(hash), (x) =>
            x.toString(16).padStart(2, "0"),
          ).join("");
          if (!articles.some((x) => x.id === id))
            articles.push({
              id,
              publisher: feed.publisher,
              sourceName: feed.name,
              topic,
              title,
              url: url.href,
              publishedAt,
              guid: text(item.guid).slice(0, 512) || null,
              summary: plainText(text(item.description)) || null,
              imageUrl: feedImage(item),
            });
        }
      return {
        articles,
        notModified: false,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
    } catch {
      throw Error("Feed RSS non disponibile o non valido: " + feed.id);
    }
  }
}
