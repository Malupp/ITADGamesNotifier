import type { ApplicationContext } from "./context.js";
import { ApiError } from "../infrastructure/http.js";
import { enabled } from "./retries.js";
import {
  publishJobs,
  publishScans,
  flushDeliveries,
} from "../runtime/queues.js";
export async function schedule(
  context: ApplicationContext,
  now: number,
  initialize = false,
  part: "all" | "prices" | "giveaways" | "recover" = "all",
): Promise<void> {
  if (!enabled(context) && !initialize) return;
  const scans = context.scans;
  if (part === "all" || part === "prices") {
    const quiet =
      initialize ||
      (await context.settings.getSetting("prices_seeded")) !== "true";
    const gameIds = await context.wishlist.gameIds();
    // Free Queues10k ops/day: cap below ~3000 messages/day incl. giveaway, commands, retries.
    // This deployment has16 games. Larger installations must explicitly resize/review quotas.
    if (gameIds.length > 200)
      await context.settings.setSetting(
        "last_scan_error",
        "prices:wishlist_capacity",
        now,
      );
    const chunks = [];
    for (let i = 0; i < gameIds.length; i += 10)
      chunks.push({
        kind: "prices" as const,
        gameIds: gameIds.slice(i, i + 10),
        quiet,
      });
    if (gameIds.length <= 200) await scans.start("prices", chunks, quiet, now);
    if (part === "prices") await publishScans(context, scans, now, "prices");
  }
  if (part === "all" || part === "giveaways") {
    const baseline =
      initialize ||
      (await context.settings.getSetting("giveaways_seeded")) !== "true";
    await scans.start(
      "giveaways",
      [{ kind: "giveaways", offset: 0, startedAt: now, baseline }],
      baseline,
      now,
    );
    if (part === "giveaways")
      await publishScans(context, scans, now, "giveaways");
  }
  if (part === "all" || part === "recover") {
    await publishScans(context, scans, now);
    if (enabled(context)) {
      await publishJobs(
        context,
        (await context.updates.pendingUpdates(now)).map((id) => ({
          kind: "update",
          id,
        })),
        "interactive",
      );
      await flushDeliveries(context, now);
    }
    // Bounded retention, independent of scan integrity; delivery history lasts90d.
    await context.env.DB.batch([
      context.env.DB.prepare(
        "DELETE FROM telegram_updates WHERE update_id IN (SELECT update_id FROM telegram_updates WHERE status='done' AND created_at<? LIMIT 100)",
      ).bind(now - 7 * 86400000),
      context.env.DB.prepare(
        "DELETE FROM deliveries WHERE id IN (SELECT id FROM deliveries WHERE status IN ('sent','expired','blocked') AND due_at<? LIMIT 100)",
      ).bind(now - 90 * 86400000),
      context.env.DB.prepare(
        "DELETE FROM scan_jobs WHERE id IN (SELECT j.id FROM scan_jobs j JOIN scan_runs r ON r.id=j.run_id WHERE r.status!='running' AND r.started_at<? LIMIT 100)",
      ).bind(now - 7 * 86400000),
      context.env.DB.prepare(
        "DELETE FROM scan_runs WHERE started_at<? AND status!='running' AND NOT EXISTS(SELECT 1 FROM scan_jobs WHERE run_id=scan_runs.id)",
      ).bind(now - 7 * 86400000),
    ]);
  }
}
