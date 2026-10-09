# ITAD notifier on Cloudflare Free

Approved intent: zero-cost services; complete PC games claimable from Italy and kept without a mandatory subscription; new giveaway alerts and meaningful wishlist reductions. The user approved Cloudflare with verification and asked to start.

## Behaviour

Check sources every 30 minutes. Send a wishlist alert only for an actual sale and an additional reduction of at least the effective threshold, measured from the last successfully delivered alert. The minimum threshold is 10%, with no rounding before comparison. Before a confirmed delivery use a valid, silently established baseline. Preserve per-game overrides, clamping legacy thresholds below 10% to the agreed minimum while retaining the original values in the private export.

Use integer euro cents. Zero is a valid price; missing prices remain null. A missing initial price must not disable monitoring. An increase must never reset the notification reference. Promotions are identified by giveaway and game IDs, not a permanent game slug. Exclude expired offers, DLC, demos, trials, permanent free-to-play lists, and subscription requirements. Use ITAD's dedicated giveaways endpoint; uncertain offers are excluded.

## Runtime

A TypeScript Worker receives authenticated Telegram webhooks. Persist accepted updates before acknowledging them; use Telegram update IDs for replay protection. Existing commands remain available with stable game-ID callbacks. D1 stores preferences, wishlist, offers, notification references, accepted updates, and an outbox.

Cloudflare Cron Triggers publish tasks to Cloudflare Queues every 30 minutes. Price tasks contain at most 10 game IDs; giveaway pages contain at most 10 source records. Queue consumers process one task per invocation. Notifications have their own tasks. Consumers acknowledge completed tasks individually; D1 leases and unique keys prevent concurrent duplicate sends. Transient failures retry, blocked recipients are isolated, expired or stale offers are discarded. The successful send and notification reference update share a D1 transaction. An uncertain Telegram send may duplicate on retry, as accepted by the user.

Free-plan sizing uses a conservative 10 ms CPU budget per invocation, 50 external fetches and 50 D1 queries. Network wait is excluded from CPU. Local benchmarks are estimates, not proof of remote CPU billing. Remote verification on the actual Free account is required before production claims. No paid plan, billing upgrade, or temporary account is selected automatically.

## Migration and rollout

Retain Python and PostgreSQL paths for rollback. Export PostgreSQL with a read-only consistent transaction to an ignored private directory; do not print secrets or user records. Generate idempotent D1 import SQL and preserve nulls, stable IDs, timestamps and uniqueness. Import legacy observed prices as baseline information, not confirmed delivery history. Import existing JSON slugs as legacy markers. The first complete giveaway scan seeds current offers silently; later campaign IDs notify normally. No initial catch-up burst.

Deploy with scans paused, apply schema, import and reconcile row counts, seed current state, inspect Free quotas and CPU, then enable scans and switch the Telegram webhook. Disable legacy scheduled production writers before activation. Never drop old data. Rollback restores polling/webhook ownership to a single deployment and pauses the new writer.

## Proof

Tests cover 100→90→89→81, 9.6% versus 10%, missing/zero prices, actual-sale validation, subscription/DLC/expired giveaways, stable callbacks, webhook replay and authentication, retries without premature baseline advancement, recipient isolation, stale delivery cancellation, and idempotent migration. Type checking, local D1 schema application, bundle dry-run and representative CPU profiling are required. Live credentials and recoverability of Railway PostgreSQL remain external prerequisites.
