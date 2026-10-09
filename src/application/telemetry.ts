export interface TimingSample {
  stage: string;
  durationMs: number;
  outcome: "ok" | "error";
}
export async function measure<T>(
  stage: "itad" | "update" | "delivery",
  action: () => Promise<T>,
  record: (sample: TimingSample) => void,
  clock: () => number = () => performance.now(),
): Promise<T> {
  const start = clock();
  let outcome: "ok" | "error" = "ok";
  try {
    return await action();
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    try {
      record({
        stage,
        durationMs: Math.max(0, Math.round((clock() - start) * 1000) / 1000),
        outcome,
      });
    } catch {
      /* Observability must not change delivery behavior. */
    }
  }
}
