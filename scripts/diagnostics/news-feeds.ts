import { NewsFeedClient } from "../../src/infrastructure/news/client.js";
import { NEWS_FEEDS } from "../../src/infrastructure/news/sources.js";
const client = new NewsFeedClient();
for (const feed of NEWS_FEEDS) {
  try {
    const result = await client.load(feed, Date.now());
    const counts: Record<string, number> = {};
    for (const article of result.articles)
      counts[article.topic] = (counts[article.topic] ?? 0) + 1;
    console.log(
      feed.name,
      JSON.stringify({ articles: result.articles.length, topics: counts }),
    );
  } catch {
    console.log(feed.name, "non disponibile o non valido");
    process.exitCode = 1;
  }
}
