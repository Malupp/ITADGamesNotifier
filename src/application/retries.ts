import type { ApplicationContext } from "./context.js";
import { ApiError } from "../infrastructure/http.js";
export const enabled = (context: ApplicationContext) =>
  context.env.SCANS_ENABLED === "true";
export const errorCode = (e: unknown) =>
  e instanceof ApiError ? String(e.status) : "internal";
export const backoff = (e: unknown, attempts: number) =>
  Math.min(
    43200,
    Math.max(
      e instanceof ApiError ? (e.retryAfter ?? 0) : 0,
      Math.min(1800, 30 * 2 ** Math.min(attempts, 6)),
    ),
  );
