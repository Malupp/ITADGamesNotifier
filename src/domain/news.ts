export const NEWS_TOPICS = ["games", "cinema", "anime_manga"] as const;
export type NewsTopic = (typeof NEWS_TOPICS)[number];
export interface NewsArticle {
  summary?: string | null;
  imageUrl?: string | null;
  id: string;
  publisher: string;
  sourceName: string;
  topic: NewsTopic;
  title: string;
  url: string;
  publishedAt: number;
  guid?: string | null;
}
export const NEWS_TTL = 86400000;
export const NEWS_WINDOW = 3600000;
export function selectNews(
  articles: NewsArticle[],
  count: number,
  cursor = 0,
  publishers: Partial<Record<NewsTopic, string>> = {},
) {
  const remaining = [...articles].sort(
    (a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id),
  );
  const selected: NewsArticle[] = [];
  const next = { ...publishers };
  for (
    let tries = 0;
    remaining.length && selected.length < count && tries < count * 3;
    tries++
  ) {
    const topic = NEWS_TOPICS[cursor % 3];
    cursor = (cursor + 1) % 3;
    const area = remaining.filter((x) => x.topic === topic);
    if (!area.length) continue;
    const sources = [...new Set(area.map((x) => x.publisher))].sort();
    const publisher =
      sources[(sources.indexOf(next[topic] ?? "") + 1) % sources.length];
    const article = area.find((x) => x.publisher === publisher)!;
    selected.push(article);
    next[topic] = publisher;
    remaining.splice(
      remaining.findIndex((x) => x.id === article.id),
      1,
    );
  }
  return { articles: selected, cursor, publishers: next };
}
