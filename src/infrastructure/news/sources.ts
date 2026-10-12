import type { NewsTopic } from "../../domain/news.js";
export interface NewsFeed {
  id: string;
  publisher: string;
  name: string;
  url: string;
  host: string;
  topic?: NewsTopic;
}
export const NEWS_FEEDS: NewsFeed[] = [
  {
    id: "multiplayer",
    publisher: "multiplayer",
    name: "Multiplayer.it",
    url: "https://multiplayer.it/feed/rss/news/",
    host: "multiplayer.it",
    topic: "games",
  },
  {
    id: "everyeye-games",
    publisher: "everyeye",
    name: "Everyeye",
    url: "https://www.everyeye.it/feed/feed_news_rss.asp",
    host: "www.everyeye.it",
    topic: "games",
  },
  {
    id: "comingsoon",
    publisher: "comingsoon",
    name: "ComingSoon.it",
    url: "https://www.comingsoon.it/feedrss/",
    host: "www.comingsoon.it",
    topic: "cinema",
  },
  {
    id: "everyeye-cinema",
    publisher: "everyeye",
    name: "Everyeye Cinema",
    url: "https://cinema.everyeye.it/feed/feed_news_rss.asp",
    host: "cinema.everyeye.it",
    topic: "cinema",
  },
  {
    id: "cinefilos",
    publisher: "cinefilos",
    name: "Cinefilos",
    url: "https://cinefilos.it/feed",
    host: "cinefilos.it",
    topic: "cinema",
  },
  {
    id: "mangaforever",
    publisher: "mangaforever",
    name: "MangaForever",
    url: "https://www.mangaforever.net/feed/",
    host: "www.mangaforever.net",
    topic: "anime_manga",
  },
  {
    id: "everyeye-anime",
    publisher: "everyeye",
    name: "Everyeye Anime",
    url: "https://anime.everyeye.it/feed/feed_news_rss.asp",
    host: "anime.everyeye.it",
    topic: "anime_manga",
  },
  {
    id: "akiba",
    publisher: "akiba",
    name: "Akiba Gamers",
    url: "https://www.akibagamers.it/feed/",
    host: "www.akibagamers.it",
  },
];
export function articleTopic(
  feed: NewsFeed,
  url: URL,
  categories: string[],
  title = "",
): NewsTopic | null {
  const cats = categories.map((x) => x.toLowerCase().trim());
  // Exclusions take precedence over a broad positive news/franchise category.
  if (
    cats.some((x) =>
      /recension|classific|i migliori|guide|rubrich|volantino|offerte tech|giochi gratis, sconti e offerte|action figure|merchandising/.test(
        x,
      ),
    )
  )
    return null;
  if (
    /\b(recension[ei]|classifica|action\s+figure|statu[ae]|statuett[ae]|funko|merchandising|gadget|polaroid|modellin[oi])\b/i.test(
      title,
    ) ||
    /\b(?:i|le)\s+(?:\d+\s+)?(?:migliori|peggiori)\b|\btop\s*\d+\b/i.test(title)
  )
    return null;
  if (feed.publisher === "everyeye" && !url.pathname.startsWith("/notizie/"))
    return null;
  if (feed.id === "comingsoon" && !cats.includes("cinema")) return null;
  if (
    feed.id === "cinefilos" &&
    !/^\/(cinema-news|trailers)\//.test(url.pathname)
  )
    return null;
  if (
    feed.id === "mangaforever" &&
    !cats.some((x) => /^news (anime|manga)$/.test(x))
  )
    return null;
  if (
    feed.id === "everyeye-anime" &&
    cats.some((x) => /fumett|comic|marvel|dc universe|action figure/.test(x))
  )
    return null;
  if (feed.id === "akiba") {
    if (cats.some((x) => /giappone|tech|figure/.test(x))) return null;
    if (cats.includes("notizie anime e manga")) return "anime_manga";
    if (
      !cats.includes("notizie") ||
      cats.some((x) => /giappone|tech|figure/.test(x))
    )
      return null;
    return "games";
  }
  return feed.topic ?? null;
}
