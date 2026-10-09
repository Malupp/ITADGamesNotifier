import type { Env, QueueJob } from "../../src/runtime/bindings.js";
import { createContext } from "../../src/application/context.js";
import { handleRequest as request } from "../../src/runtime/webhook.js";
import { schedule as tick } from "../../src/application/scheduler.js";
import { processJob as job } from "../../src/runtime/consumer.js";
export const handleRequest = (r: Request, env: Env, now?: number) =>
  request(r, createContext(env), now);
export const schedule = (
  env: Env,
  now: number,
  initialize = false,
  part: "all" | "prices" | "giveaways" | "recover" = "all",
) => tick(createContext(env), now, initialize, part);
export const processJob = (
  body: QueueJob,
  env: Env,
  now: number,
  fetcher: typeof fetch = fetch,
) => job(body, createContext(env, { fetcher }), now);
