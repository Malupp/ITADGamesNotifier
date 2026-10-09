import type { ApplicationContext } from "../application/context.js";
import type { QueueJob } from "./bindings.js";
import { enabled } from "../application/retries.js";
import { Scans } from "../infrastructure/d1/scans.js";
export async function sendJobs(
  context: ApplicationContext,
  jobs: QueueJob[],
): Promise<void> {
  await publishJobs(context, jobs, "background");
}
export async function publishJobs(
  context: ApplicationContext,
  jobs: QueueJob[],
  lane: "interactive" | "background",
): Promise<void> {
  const queue =
    lane === "interactive"
      ? (context.env.INTERACTION_QUEUE ?? context.env.WORK_QUEUE)
      : context.env.WORK_QUEUE;
  for (let i = 0; i < jobs.length; i += 100)
    await queue.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
}
export async function publishScans(
  context: ApplicationContext,
  scans: Scans,
  now: number,
  kind: "prices" | "giveaways" | null = null,
): Promise<void> {
  const ids = await scans.dispatch(now, kind);
  try {
    await sendJobs(
      context,
      ids.map((id) => ({ kind: "scan", id })),
    );
  } catch (e) {
    await scans.releaseDispatch(ids, now);
    throw e;
  }
}
export async function enqueueTick(
  context: ApplicationContext,
  now: number,
  initialize = false,
): Promise<void> {
  if (!enabled(context) && !initialize) return;
  await sendJobs(
    context,
    (["prices", "giveaways", "recover"] as const).map((part) => ({
      kind: "tick",
      part,
      scheduledAt: now,
      initialize,
    })),
  );
}
export async function flushDeliveries(
  context: ApplicationContext,
  now: number,
): Promise<void> {
  await context.deliveries.cancelInvalidPending(now);
  const jobs = await context.deliveries.pendingDeliveryJobs(now, 20);
  await publishJobs(
    context,
    jobs
      .filter((job) => job.kind === "reply")
      .map((job) => ({ kind: "delivery", id: job.id })),
    "interactive",
  );
  await publishJobs(
    context,
    jobs
      .filter((job) => job.kind !== "reply")
      .map((job) => ({ kind: "delivery", id: job.id })),
    "background",
  );
}
