# D1 read usage and Workers RSS recovery

## Confirmed causes

The 12 October D1 alert reflected excessive rows scanned, rather than idle
hosting charges. Query Insights over the preceding 24 hours attributed 2,797,760
rows to price run completion, 1,512,464 to key observation updates, and 697,656 to
key run completion. These totals cover a rolling window, not the UTC daily quota
window. Missing indexes caused historical jobs or unrelated observations to be
scanned repeatedly.

The news toggle was enabled for one group. All eight sources failed before any
feed was initialized: calling native Workers `fetch` through `this.fetcher(...)`
passed a `NewsFeedClient` instance as its receiver and raised an illegal invocation
error. Node's fetch and the previous fake clients did not expose this difference.

## Change and verification

- Call the injected fetch function through a local variable, with no client receiver.
- Migration `0009_d1_query_indexes.sql` adds six indexes for run completion,
  observation updates, retention, and news cycle completion. It changes no data.
- New Workers/Miniflare regression test failed before the fetch change and passed
  afterward. New SQLite query-plan test failed before the indexes and passed afterward;
  it also verifies that an observation update affects only the requested game.
- Full suite: 165 passed, zero failed. Typecheck and deploy dry run passed.
- Independent review approved the implementation and query plans.
- Migration applied locally and remotely. Worker version:
  `49616263-848f-44e0-aee8-dcca992dd109`.

Three identical read-only production probes for a nonexistent run/game read
3,613 + 1,463 + 454 rows before the indexes and 0 + 0 + 1 afterward. This proves
the avoided scans on those probes; it is not a measurement of total daily savings.

At 20:09 UTC all eight live feeds were initialized and 130 articles had been
stored (62 games, 52 cinema, 16 anime/manga). No delivery was created: the first
successful read deliberately seeds silently. The next scheduled poll is 20:30
UTC / 22:30 Europe/Rome. Only subsequent eligible publications may be delivered
to the enabled group, subject to the existing three-attempts-per-hour limit.
An actual subsequent news delivery was not yet observed at this checkpoint.

## Operations

A D1 Time Travel bookmark was recorded privately before applying the additive
indexes. Diagnostic outputs remain under the ignored `.wrangler/` directory.
No subscription upgrade, group toggle change, synthetic news message, or full
price rescan was used for this recovery. The accumulated daily read count is not
reduced by adding indexes; future queries benefit from them.

References: [D1 row accounting](https://developers.cloudflare.com/d1/platform/pricing/),
[Query Insights](https://developers.cloudflare.com/d1/observability/metrics-analytics/),
[Workers illegal invocation errors](https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors).
