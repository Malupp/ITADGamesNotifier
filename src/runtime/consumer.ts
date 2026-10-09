import { ItadClient } from "../infrastructure/itad/client.js";
import { measure } from "../application/telemetry.js";
import type { ApplicationContext } from "../application/context.js";
import type { QueueJob } from "./bindings.js";
import { schedule } from "../application/scheduler.js";
import { processDelivery } from "../application/delivery.js";
import { processUpdate } from "../application/update.js";
import { processScan } from "../application/scan-job.js";
import { processKeyScan } from "../application/keys.js";

export async function processJob(
  job: QueueJob,
  context: ApplicationContext,
  now: number,
): Promise<number | null> {
  switch (job.kind) {
    case "tick":
      await schedule(context, now, job.initialize, job.part);
      return null;
    case "delivery":
      return processDelivery(job.id, context, now);
    case "update":
      return processUpdate(job.id, context, now);
    case "scan":
      return processScan(job.id, context, now);
    case "keyscan":
      return processKeyScan(job.id, context, now);
    case "probe": {
      const started = performance.now();
      const client = job.reviewConcurrency
        ? new ItadClient(context.env.ITAD_API_KEY, context.fetcher, {
            reviewConcurrency: job.reviewConcurrency,
            measureRequest: (action) =>
              measure("itad", action, context.recordTiming),
          })
        : context.itad;
      const result =
        job.scenario === "deals"
          ? await client.getDeals({
              maxPriceCents: 5000,
              minScore: 75,
              limit: 10,
            })
          : await client.getPrices(
              (await context.wishlist.gameIds()).slice(0, 10),
            );
      await context.settings.setSetting(
        "probe_" +
          job.scenario +
          (job.reviewConcurrency ? "_" + job.reviewConcurrency : ""),
        JSON.stringify({
          at: now,
          durationMs: Math.round(performance.now() - started),
          reviewConcurrency:
            job.reviewConcurrency ??
            Number(context.env.REVIEW_CONCURRENCY ?? 1),
          count: result instanceof Map ? result.size : result.length,
        }),
        now,
      );
      return null;
    }
  }
}
