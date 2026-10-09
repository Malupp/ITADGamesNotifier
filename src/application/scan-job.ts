import type { ApplicationContext } from "./context.js";
import { ApiError } from "../infrastructure/http.js";
import type { PriceQuote } from "../domain/models.js";
import { enabled, backoff, errorCode } from "./retries.js";
import { sendJobs, flushDeliveries } from "../runtime/queues.js";
import { normalizeGiveaways } from "../domain/promotions.js";
import {
  verifyGiveaways,
  confirmOfficialGiveaways,
} from "../infrastructure/stores/verification.js";
export async function processScan(
  id: string,
  context: ApplicationContext,
  now: number,
): Promise<number | null> {
  const scans = context.scans,
    claim = await scans.claim(id, now);
  if (!claim) {
    // A previous attempt may have committed the page, then failed to publish its successor.
    await sendJobs(
      context,
      (await scans.successors(id, now)).map((id) => ({ kind: "scan", id })),
    );
    if (enabled(context)) await flushDeliveries(context, now);
    return null;
  }
  const task = claim.task;
  if (
    !enabled(context) &&
    !(task.kind === "prices" ? task.quiet : task.baseline)
  ) {
    await scans.retry(id, claim.token, now + 1800000);
    return null;
  }
  try {
    const itad = context.itad;
    if (task.kind === "prices") {
      const prices = await itad.getPrices(task.gameIds);
      const quotes: PriceQuote[] = task.gameIds.flatMap((id) => {
        const best = (prices.get(id) ?? []).sort(
          (a, b) => a.priceCents - b.priceCents,
        )[0];
        return best ? [best] : [];
      });
      await context.deliveries.cancelInvalidPending(now);
      await context.wishlist.invalidateMissingPrices(
        task.gameIds.filter((id) => !quotes.some((q) => q.gameId === id)),
        now,
      );
      await context.wishlist.ingestPrices(quotes, now, task.quiet);
      await scans.complete(id, claim.token, claim.runId, now);
      if (enabled(context) && !task.quiet) await flushDeliveries(context, now);
    } else {
      if (task.offset > 500) throw new ApiError(502);
      const page = await itad.getGiveaways(task.offset, 1);
      const candidates = normalizeGiveaways(page.items, now);
      // Reject unexpectedly large pages rather than breaching Free fetch/CPU budgets.
      const ids = [...new Set(candidates.map((o) => o.gameId))];
      if (ids.length > 10) throw new ApiError(502);
      const verified = await confirmOfficialGiveaways(
        verifyGiveaways(candidates, await itad.getPrices(ids)),
        context.fetcher,
        now,
      );
      await context.settings.setSetting(
        "giveaway_unverified_last_page",
        String(candidates.length - verified.length),
        now,
      );
      await context.giveaways.ingestGiveaways(
        verified,
        [
          context.env.TELEGRAM_CHAT_ID ?? "",
          context.env.TELEGRAM_CHAT_GROUP ?? "",
        ],
        now,
        task.baseline,
      );
      if (page.hasMore) {
        const next = { ...task, offset: task.offset + 1 };
        await scans.complete(id, claim.token, claim.runId, now, next);
        await context.env.WORK_QUEUE.send({
          kind: "scan",
          id: claim.runId + ":" + next.offset,
        });
      } else {
        await context.giveaways.finishGiveawayScan(task.startedAt, now);
        await scans.complete(id, claim.token, claim.runId, now);
      }
      if (enabled(context) && !task.baseline)
        await flushDeliveries(context, now);
    }
    return null;
  } catch (e) {
    const delay = backoff(e, claim.attempts);
    await scans.retry(id, claim.token, now + delay * 1000);
    await context.settings.setSetting(
      "last_scan_error",
      task.kind + ":" + errorCode(e),
      now,
    );
    return delay;
  }
}
