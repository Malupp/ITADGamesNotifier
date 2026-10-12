import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
test("RSS loads in the real Workers runtime using the global fetch function", async () => {
  const bundled = await build({
    stdin: {
      contents: `import {NewsFeedClient} from './src/infrastructure/news/client.ts';import {NEWS_FEEDS} from './src/infrastructure/news/sources.ts';export default {async fetch(){const result=await new NewsFeedClient().load(NEWS_FEEDS[0],Date.now());return Response.json({count:result.articles.length,title:result.articles[0]?.title});}}`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  let requests = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-10-08",
      script: bundled.outputFiles[0].text,
      outboundService: async () => {
        requests++;
        return new Response(
          `<rss><channel><language>it-IT</language><item><title>Notizia italiana</title><link>https://multiplayer.it/notizie/gioco.html</link><pubDate>${new Date(Date.now() - 1000).toUTCString()}</pubDate></item></channel></rss>`,
        );
      },
    }),
  );
  try {
    const response = await mf.dispatchFetch("https://worker.example/");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      count: 1,
      title: "Notizia italiana",
    });
    assert.equal(requests, 1);
  } finally {
    await mf.dispose();
  }
});
