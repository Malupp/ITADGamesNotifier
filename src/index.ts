import type { Env, QueueJob } from "./runtime/bindings.js";
import { createContext } from "./application/context.js";
import { handleRequest } from "./runtime/webhook.js";
import { enqueueTick } from "./runtime/queues.js";
import { processJob } from "./runtime/consumer.js";

export default {
  fetch(request: Request, env: Env) {
    return handleRequest(request, createContext(env));
  },
  async scheduled(event: ScheduledController, env: Env) {
    await enqueueTick(createContext(env), event.scheduledTime);
  },
  async queue(batch: MessageBatch<QueueJob>, env: Env) {
    const context = createContext(env);
    for (const message of batch.messages) {
      try {
        const delay = await processJob(message.body, context, Date.now());
        if (delay === null) message.ack();
        else message.retry({ delaySeconds: delay });
      } catch {
        console.error("job_failed", { kind: message.body.kind });
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, QueueJob>;
