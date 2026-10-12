import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/sqlite.js";
test("finishing runs and refreshing watched prices search by their key rather than scanning history", (t) => {
  const d = testDatabase();
  t.after(d.close);
  d.sqlite
    .exec(`WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3000)
    INSERT INTO scan_jobs(id,run_id,payload,status,due_at) SELECT 'history:'||x,'history-run:'||(x%100),'{}','done',1 FROM n;
    INSERT INTO key_scan_jobs SELECT * FROM scan_jobs;
    WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
    INSERT INTO key_alert_state(mode,owner_id,game_id,observed,generation) SELECT 'general','owner','game:'||x,1000,0 FROM n;`);
  for (const table of ["scan_jobs", "key_scan_jobs"]) {
    const plan = d.sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE run_id=? AND status!='done'`,
      )
      .all("current-run");
    assert.ok(
      plan.some((row) => String(row.detail).includes("SEARCH " + table)),
      JSON.stringify(plan),
    );
  }
  const plan = d.sqlite
    .prepare(
      "EXPLAIN QUERY PLAN UPDATE key_alert_state SET observed=json_extract(q.value,'$.keyCents') FROM json_each(?) q WHERE game_id=json_extract(q.value,'$.id')",
    )
    .all('[{"id":"game:1","keyCents":800}]');
  assert.ok(
    plan.some((row) => String(row.detail).includes("SEARCH key_alert_state")),
    JSON.stringify(plan),
  );
  d.sqlite
    .prepare(
      "UPDATE key_alert_state SET observed=json_extract(q.value,'$.keyCents') FROM json_each(?) q WHERE game_id=json_extract(q.value,'$.id')",
    )
    .run('[{"id":"game:1","keyCents":800}]');
  assert.equal(
    d.sqlite
      .prepare("SELECT observed FROM key_alert_state WHERE game_id='game:1'")
      .get()!.observed,
    800,
  );
  assert.equal(
    d.sqlite
      .prepare("SELECT COUNT(*) AS n FROM key_alert_state WHERE observed=1000")
      .get()!.n,
    999,
  );
});
