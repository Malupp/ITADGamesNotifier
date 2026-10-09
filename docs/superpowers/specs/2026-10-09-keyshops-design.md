# Keyshop alerts — design

Approved scope: the user said Implementa after agreeing to ITAD + GG.deals, wishlist and general bargains, general key price <= 1000 cents and <= half the best authorized retail price. Keep the existing 30-minute schedule, free services, complete PC games, compact interactive messages and a quiet initial baseline.

## Boundaries
- GG Prices API, region it, currency EUR, Steam app IDs; retain attribution/link. Generic keyshop minimum only: no vendor, checkout fees or activation assurance can be inferred.
- ITAD remains responsible for authorized retail prices and game identities. Map Steam app IDs only from the authenticated ITAD full-game info response, cache mappings for seven days. Never match by title alone.
- General pool: up to 100 ITAD popular games plus 30 current ITAD deals, deduplicated with at most 200 distinct wishlist games. This is a monitored selection, not a full keyshop catalog.
- Poll every 30 minutes. GG declares hourly refresh. Local API budget <=100 records/minute and <=900/hour leaves headroom; persist counters across queues and retry 429 without changing baselines.
- Separate key wishlist baselines from existing retail baselines. New wishlist entries seed quietly. General first rollout seeds quietly; afterwards new qualifying candidates or further >=10% drops may notify. Only successful Telegram delivery advances references. No repeat for minor changes or seller changes at the same price.
- General eligibility: positive key price <=1000 cents, positive best retail price, key*2 <= retail. Best retail is the minimum of valid ITAD and GG authorized prices; free official price prevents a paid bargain alert.
- Recheck key prices/eligibility immediately before delivery, enforce removal, current thresholds and stale-data rejection, retry API failures. Existing giveaway verification and previews continue unchanged.

## Architecture
Add a GG client, pure key pricing rules, dedicated D1 keys repository and independent durable key scan pipeline. Add source to the existing outbox rather than repurposing retail baselines. Additive migration preserves old state and leases. Recovery republishes persisted key jobs after failure. Mapping jobs do one metadata fetch per invocation; price jobs fetch <=20 mapped IDs. Discovery is cached daily.

## Product
Wishlist/search/comparison show authorized prices and a labeled GG keyshop minimum with fetch time/history/link. /keys lists qualifying general bargains in the existing one-message paginator. Paid searches keep their existing store filters. Help/status describe coverage, thresholds and data freshness. General alerts use existing configured destination chats; personal key alerts use the requesting user's private chat.

## Proof/release
RED->GREEN adapter, quota, data preservation, dedupe, threshold, retry/removal/rebound, durable successor/recovery, and compact UI tests. Full existing suite, Python exporter, typecheck/build; independent final review. Private remote D1 backup plus restore before migration. Load secret locally without logging it, apply additive migration, deploy, verify silent seed and healthy cron/webhook. Merge/publish within the user's existing authorization, keep user edits and backups.
