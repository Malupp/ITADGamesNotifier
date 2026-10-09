export class ApiError extends Error {
  constructor(
    public status: number,
    public retryAfter?: number,
    public permanent = false,
    public telegramReason?: "not_modified" | "message_missing",
  ) {
    super(`API request failed (${status})`);
    this.name = "ApiError";
  }
}
export async function request(
  fetcher: typeof fetch,
  url: string | URL,
  init: RequestInit,
  telegram = false,
): Promise<unknown> {
  try {
    const response = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(
        response.ok ? 502 : response.status,
        undefined,
        telegram && (response.status === 400 || response.status === 403),
      );
    }
    if (!response.ok || (telegram && record(data).ok !== true)) {
      const status =
        telegram && positiveInt(record(data).error_code)
          ? data.error_code
          : response.status;
      const retry =
        record(record(data).parameters).retry_after ??
        Number(response.headers.get("Retry-After"));
      throw new ApiError(
        status,
        positiveInt(retry) && retry > 0 ? retry : undefined,
        telegram && (status === 400 || status === 403),
        telegram && status === 400 && typeof data?.description === "string"
          ? data.description.includes("message is not modified")
            ? "not_modified"
            : /message to edit not found|message can't be edited/.test(
                  data.description,
                )
              ? "message_missing"
              : undefined
          : undefined,
      );
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Fetch errors may contain credentials, request URLs or response bodies.
    throw new ApiError(0);
  }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}
function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
