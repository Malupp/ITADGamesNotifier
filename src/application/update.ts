import { measure } from "./telemetry.js";
import type { ApplicationContext } from "./context.js";
import { ApiError } from "../infrastructure/http.js";
import type { TelegramUpdate } from "../domain/models.js";
import { backoff } from "./retries.js";
import { flushDeliveries } from "../runtime/queues.js";
import { createSession } from "../telegram/session.js";
import { handleCallback } from "../telegram/callbacks.js";
import { handleCommand } from "../telegram/commands.js";

export async function processUpdate(
  id: number,
  context: ApplicationContext,
  now: number,
): Promise<number | null> {
  const claim = await context.updates.claimUpdate(id, now);
  if (!claim) {
    // A completed command may still have an unpublished durable reply.
    await flushDeliveries(context, now);
    return null;
  }
  context.recordTiming({
    stage: claim.attempts === 1 ? "update_queue_first" : "update_queue_retry",
    durationMs: Math.max(
      0,
      now - (claim.attempts === 1 ? claim.createdAt : claim.dueAt),
    ),
    outcome: "ok",
  });
  try {
    const user =
      claim.update.callback_query?.from ?? claim.update.message?.from;
    if (user) await context.deliveries.unblockChat(String(user.id));
    await measure(
      "update",
      () => handleUpdate(context, claim.update),
      context.recordTiming,
    );
    await context.updates.completeUpdate(id, claim.token);
    await flushDeliveries(context, Date.now());
    return null;
  } catch (e) {
    const delay = backoff(e, 1);
    await context.updates.retryUpdate(id, claim.token, now + delay * 1000);
    return delay;
  }
}

export async function handleUpdate(
  context: ApplicationContext,
  update: TelegramUpdate,
): Promise<void> {
  const session = createSession(context, update);
  if (!session) return;
  if (update.callback_query) await handleCallback(session);
  else await handleCommand(session);
}
