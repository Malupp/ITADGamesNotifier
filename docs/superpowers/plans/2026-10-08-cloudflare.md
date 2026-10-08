# Cloudflare Free implementation plan

> **For agentic workers:** implement the independent tasks with the declared file ownership; run test-first checks, then integrate and request a fresh review.

**Goal:** rehost the Telegram notifier on free Cloudflare services while preserving state and avoiding duplicate or insignificant alerts.
**Architecture:** webhook and Cron producers persist and publish small Queue tasks; consumers use D1 leases and an outbox. TypeScript retains the current bot commands and Python remains available for rollback.
**Tech stack:** TypeScript, Workers Free, D1 Free, Queues Free, Wrangler, Node tests with real SQLite.
**Spec:** ../specs/2026-10-08-cloudflare-design.md

## Global constraints

- Services must remain Free; no trial-only or automatic paid upgrades.
- Schedule source checks every 30 minutes; consumers handle one task and at most 10 games/source records.
- At least 10% additional reduction from confirmed notification reference; compare integer cents without rounding percentages.
- First observation/import is quiet. Preserve existing data and retain the legacy implementation.
- No secrets, database exports or personal records in tracked artifacts or logs.

## Review focus

- Duplicate queue deliveries after a send succeeded but acknowledgement failed.
- Price rebound while an alert waits in the outbox.
- Database/API outage during the first quiet giveaway scan.
- Telegram user blocked the bot while other recipients remain reachable.
- Legacy null/zero prices and per-game null preference inheritance.

## Tasks

1. **Domain and storage:** create `src/types.ts`, `src/domain.ts`, `src/store.ts`, `migrations/0001_initial.sql` and domain/store tests. Pin cent-based thresholds, eligibility, real SQLite transactions, quiet initialization and delivery leases with failing tests, then implement and rerun.
2. **API and commands:** create `src/clients.ts`, `src/bot.ts` and their tests. Consume the shared types and Store interface; produce `ItadClient`, `TelegramClient`, `handleUpdate`. Validate external responses, timeouts, rate limits, stable callback IDs and existing command flows. Own only these modules/tests.
3. **Migration tools:** create `scripts/export_legacy.py`, `scripts/import_legacy.ts` and migration tests. Consume the D1 schema. Produce a private, consistent PostgreSQL JSON export and repeatable SQLite import without claiming legacy observations were delivered. Own only these scripts/tests.
4. **Worker orchestration:** create `src/worker.ts`, worker tests and `wrangler.jsonc`. Authenticate and persist webhook updates, route bounded Queue jobs, scan at `*/30 * * * *`, retry transient faults and reconcile stale/expired messages. Exercise state transitions, not mocks alone.
5. **Verification and operations:** create `scripts/benchmark.ts`, deployment/migration documentation and CI checks. Run `npm test`, `npm run typecheck`, `npm run db:local`, `npm run build`, and `npm run benchmark`. Obtain a fresh review, fix meaningful findings, preserve user modifications during integration.
6. **External rollout:** only with an authenticated Free Cloudflare account and available legacy export: create D1/Queues, apply schema, import/reconcile, paused deployment, inspect actual CPU and quotas, activate and switch webhook. If access is missing, finish all independent local work and report the precise remaining prerequisite.
