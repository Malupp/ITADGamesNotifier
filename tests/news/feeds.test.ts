import test from "node:test";
import assert from "node:assert/strict";
import { NewsFeedClient } from "../../src/infrastructure/news/client.js";
import { NEWS_FEEDS } from "../../src/infrastructure/news/sources.js";
import { selectNews } from "../../src/domain/news.js";
const now = Date.parse("2026-10-11T12:00:00Z");
export function rss(
  link: string,
  category = "Cinema",
  title = "Novità &amp; trailer",
  date = now - 1000,
  language = "it-IT",
) {
  return `<rss version="2.0"><channel><language>${language}</language><item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${new Date(date).toUTCString()}</pubDate><category>${category}</category></item></channel></rss>`;
}
const examples = [
  ["https://multiplayer.it/notizie/nuovo-gioco.html", "Notizie"],
  ["https://www.everyeye.it/notizie/gioco-123.html", "Steam"],
  ["https://www.comingsoon.it/cinema/news/film/n123/", "Cinema"],
  ["https://cinema.everyeye.it/notizie/film-123.html", "Film"],
  ["https://cinefilos.it/cinema-news/2026/film-123", "2026"],
  ["https://www.mangaforever.net/novita-naruto/", "News Anime"],
  ["https://anime.everyeye.it/notizie/one-piece-123.html", "One Piece"],
  ["https://www.akibagamers.it/11-10-2026/novita/", "Notizie Anime e Manga"],
];
test("eight Italian feeds parse metadata, CDATA and entities", async () => {
  assert.equal(NEWS_FEEDS.length, 8);
  for (const [i, feed] of NEWS_FEEDS.entries()) {
    const client = new NewsFeedClient(
      async () => new Response(rss(...(examples[i] as [string, string]))),
    );
    const result = await client.load(feed, now);
    assert.equal(result.articles.length, 1, feed.id);
    assert.equal(result.articles[0].title, "Novità & trailer");
    assert.equal(result.articles[0].publisher, feed.publisher);
  }
});
test("filters language, categories, dates and foreign/unsafe links", async () => {
  const load = async (i: number, xml: string) =>
    (
      await new NewsFeedClient(async () => new Response(xml)).load(
        NEWS_FEEDS[i],
        now,
      )
    ).articles;
  for (const lang of ["en-US", "fr"])
    assert.deepEqual(
      await load(0, rss(examples[0][0], "", "News", now, lang)),
      [],
    );
  assert.equal(
    (await load(0, rss(examples[0][0], "", "Final Fantasy", now, ""))).length,
    1,
  );
  for (const link of [
    "https://evil.test/x",
    "http://multiplayer.it/x",
    "https://multiplayer.it@evil.test/x",
  ])
    assert.deepEqual(await load(0, rss(link)), []);
  assert.deepEqual(
    await load(1, rss("https://tech.everyeye.it/notizie/telefono.html")),
    [],
  );
  assert.deepEqual(await load(2, rss(examples[2][0], "TV")), []);
  assert.deepEqual(
    await load(
      4,
      rss("https://cinefilos.it/serie-tv/rookie-123", "The Rookie"),
    ),
    [],
  );
  assert.deepEqual(await load(5, rss(examples[5][0], "News Film")), []);
  assert.deepEqual(await load(7, rss(examples[7][0], "Recensioni")), []);
  for (const date of [now + 3600000, now - 86400001])
    assert.deepEqual(await load(0, rss(examples[0][0], "", "News", date)), []);
  assert.deepEqual(
    await load(0, rss(examples[0][0]).replace(/<pubDate>.*?<\/pubDate>/, "")),
    [],
  );
});
test("rejects malformed XML, DTD and oversized responses; supports HTTP validators", async () => {
  for (const xml of [
    "<rss><channel></rss>",
    '<!DOCTYPE rss [<!ENTITY e "x">]><rss/>',
    "x".repeat(524289),
  ]) {
    await assert.rejects(
      new NewsFeedClient(async () => new Response(xml)).load(
        NEWS_FEEDS[0],
        now,
      ),
    );
  }
  let headers: Headers | undefined;
  const result = await new NewsFeedClient(async (_url, init) => {
    headers = new Headers(init?.headers);
    return new Response(null, { status: 304 });
  }).load(NEWS_FEEDS[0], now, { etag: "abc", lastModified: "yesterday" });
  assert.equal(result.notModified, true);
  assert.equal(headers?.get("If-None-Match"), "abc");
});
test("canonical identities deduplicate tracking URLs and balance areas/publishers", async () => {
  const base = examples[0][0];
  const a = (
    await new NewsFeedClient(
      async () => new Response(rss(base + "?utm_source=rss#x")),
    ).load(NEWS_FEEDS[0], now)
  ).articles[0];
  const b = (
    await new NewsFeedClient(async () => new Response(rss(base))).load(
      NEWS_FEEDS[0],
      now,
    )
  ).articles[0];
  assert.equal(a.id, b.id);
  assert.equal(a.url, base);
  const candidates = [
    a,
    { ...a, id: "b", publisher: "another" },
    { ...a, id: "c", topic: "cinema" as const },
    { ...a, id: "d", topic: "anime_manga" as const },
  ];
  const first = selectNews(candidates, 3, 0, {});
  assert.deepEqual(
    first.articles.map((x) => x.topic),
    ["games", "cinema", "anime_manga"],
  );
  assert.notEqual(
    selectNews(candidates, 1, first.cursor, first.publishers).articles[0]
      .publisher,
    first.articles[0].publisher,
  );
});
test("multiple categories, fifty-item cap and bounded escaped links", async () => {
  const xml = rss(examples[5][0], "News Film").replace(
    "</category>",
    "</category><category>News Manga</category>",
  );
  assert.equal(
    (
      await new NewsFeedClient(async () => new Response(xml)).load(
        NEWS_FEEDS[5],
        now,
      )
    ).articles.length,
    1,
  );
  const item = rss(examples[0][0]).match(/<item>.*<\/item>/)![0];
  const many =
    "<rss><channel>" +
    Array.from({ length: 60 }, (_, i) =>
      item.replace(examples[0][0], examples[0][0] + "?id=" + i),
    ).join("") +
    "</channel></rss>";
  assert.equal(
    (
      await new NewsFeedClient(async () => new Response(many)).load(
        NEWS_FEEDS[0],
        now,
      )
    ).articles.length,
    50,
  );
  const long = rss(examples[0][0] + "?q=" + "a".repeat(3000));
  assert.equal(
    (
      await new NewsFeedClient(async () => new Response(long)).load(
        NEWS_FEEDS[0],
        now,
      )
    ).articles.length,
    0,
  );
});
test("real mixed-feed categories and franchise-labelled merchandise/rankings are excluded", async () => {
  const cases: [number, string, string, string][] = [
    [
      1,
      "https://www.everyeye.it/notizie/gadget-848000.html",
      "Volantino e Offerte Tech",
      "One Piece: accessori in offerta",
    ],
    [
      1,
      "https://www.everyeye.it/notizie/steam-848001.html",
      "Giochi gratis, sconti e offerte",
      "Steam: offerte del weekend",
    ],
    [
      1,
      "https://www.everyeye.it/articoli/guida-gears-848.html",
      "Gears of War",
      "Gears of War: guida",
    ],
    [
      6,
      "https://anime.everyeye.it/notizie/one-piece-848.html",
      "ONE PIECE",
      "One Piece: la nuova statua da oltre 1000 euro",
    ],
    [
      6,
      "https://anime.everyeye.it/notizie/anime-848.html",
      "Anime News",
      "I 10 migliori anime di sempre: la classifica",
    ],
    [
      4,
      "https://cinefilos.it/recensioni/film-848",
      "Cinema",
      "Film: recensione",
    ],
    [
      7,
      "https://www.akibagamers.it/manga-review/",
      "Notizie Anime e Manga</category><category>Recensioni",
      "Recensione manga",
    ],
    [
      5,
      "https://www.mangaforever.net/manga-list/",
      "News Manga</category><category>I Migliori",
      "I migliori manga del mese",
    ],
  ];
  for (const [index, url, category, title] of cases) {
    const result = await new NewsFeedClient(
      async () => new Response(rss(url, category, title)),
    ).load(NEWS_FEEDS[index], now);
    assert.equal(result.articles.length, 0, title);
  }
  const valid = await new NewsFeedClient(
    async () =>
      new Response(
        rss(
          "https://anime.everyeye.it/notizie/one-piece-film-848.html",
          "ONE PIECE",
          "One Piece: annunciato il nuovo film",
        ),
      ),
  ).load(NEWS_FEEDS[6], now);
  assert.equal(valid.articles.length, 1);
});
test("retained query parameters canonicalize equally with tracking; GUID is retained", async () => {
  const load = async (url: string) =>
    (
      await new NewsFeedClient(
        async () =>
          new Response(
            rss(url).replace(
              "</link>",
              '</link><guid isPermaLink="false">rss-123</guid>',
            ),
          ),
      ).load(NEWS_FEEDS[0], now)
    ).articles[0];
  const a = await load(examples[0][0] + "?q=one%20two"),
    b = await load(examples[0][0] + "?q=one%20two&amp;utm_source=rss");
  assert.equal(a.id, b.id);
  assert.equal(a.guid, "rss-123");
});
