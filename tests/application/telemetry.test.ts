import assert from "node:assert/strict";
import test from "node:test";
import { measure } from "../../src/application/telemetry.js";

test("timing records only duration, stage and outcome while preserving the result", async () => {
  const samples: any[] = [],
    ticks = [100, 145];
  const result = await measure(
    "update",
    async () => ({ privateText: "fixture-private-text" }),
    (s) => samples.push(s),
    () => ticks.shift()!,
  );
  assert.deepEqual(result, { privateText: "fixture-private-text" });
  assert.deepEqual(samples, [
    { stage: "update", durationMs: 45, outcome: "ok" },
  ]);
  assert.ok(!JSON.stringify(samples).includes("fixture-private-text"));
});
test("timing preserves the original failure without logging its sensitive contents", async () => {
  const samples: any[] = [],
    ticks = [100, 120],
    failure = new Error("fixture-private-token");
  await assert.rejects(
    () =>
      measure(
        "itad",
        async () => {
          throw failure;
        },
        (s) => samples.push(s),
        () => ticks.shift()!,
      ),
    (error) => error === failure,
  );
  assert.deepEqual(samples, [
    { stage: "itad", durationMs: 20, outcome: "error" },
  ]);
  assert.ok(!JSON.stringify(samples).includes("fixture-private-token"));
});
