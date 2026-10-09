import assert from "node:assert/strict";
import test from "node:test";
import {
  generateImportSql,
  writePrivateSql,
} from "../../scripts/migration/import_legacy.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabase } from "../helpers/sqlite.ts";

const GAME = "018dbe51-9b29-70d6-bb35-6306ad056241";
function fixture() {
  return {
    version: 1,
    exported_at: "2026-10-08T10:00:00Z",
    legacy_timestamp_timezone: "UTC",
    wishlist: [
      {
        user_id: "9223372036854775807",
        username: "O'Brien 🐱",
        game_slug: GAME,
        game_title: "Gioco '); DROP TABLE wishlist; -- 🎮",
        price_at_add: "100.00",
        last_notified_price: "90.00",
        added_at: "2024-01-02T03:04:05Z",
        min_discount_pct: 5,
        last_notified_shop: "Shop",
        last_notified_url: "https://example.com/",
      },
    ],
    user_prefs: [
      {
        user_id: "9223372036854775807",
        username: "O'Brien 🐱",
        price_threshold: "5.10",
        min_cut: 0,
        min_score: 0,
        min_discount_pct: 4,
      },
    ],
    sent_deals: ["a'b", "a\nb", "a'b"],
  };
}

test("imports exact cents, stable IDs and observations without fabricating delivery history", () => {
  const db = testDatabase();
  try {
    const input = fixture();
    db.sqlite.exec(generateImportSql(input));
    const row = db.sqlite.prepare("SELECT * FROM wishlist").get()!;
    assert.equal(row.user_id, "9223372036854775807");
    assert.equal(row.game_id, GAME);
    assert.equal(row.title, input.wishlist[0].game_title);
    assert.equal(row.username, "O'Brien 🐱");
    assert.equal(row.price_at_add_cents, 10000);
    assert.equal(row.baseline_price_cents, 9000);
    assert.equal(row.last_observed_price_cents, 9000);
    assert.equal(row.last_notified_price_cents, null);
    assert.equal(row.last_notified_at, null);
    assert.equal(row.last_observed_at, 1791453600000);
    assert.equal(row.baseline_origin, "legacy_observed");
    assert.equal(row.added_at, 1704164645000);
    assert.equal(row.min_discount_pct, 10);
    const prefs = db.sqlite.prepare("SELECT * FROM user_prefs").get()!;
    assert.equal(prefs.threshold_cents, 510);
    assert.equal(prefs.min_discount_pct, 10);
    assert.equal(
      db.sqlite.prepare("SELECT count(*) AS n FROM legacy_sent_slugs").get()!.n,
      2,
    );
  } finally {
    db.close();
  }
});

test("repeat imports preserve later live preferences and successful notification references", () => {
  const db = testDatabase();
  try {
    const sql = generateImportSql(fixture());
    db.sqlite.exec(sql);
    db.sqlite.exec(
      "UPDATE wishlist SET last_notified_price_cents = 8100, last_notified_at = 1234, baseline_price_cents = 8200; UPDATE user_prefs SET threshold_cents = 1234;",
    );
    db.sqlite.exec(sql);
    const row = db.sqlite.prepare("SELECT * FROM wishlist").get()!;
    assert.equal(row.last_notified_price_cents, 8100);
    assert.equal(row.last_notified_at, 1234);
    assert.equal(row.baseline_price_cents, 8200);
    assert.equal(
      db.sqlite.prepare("SELECT threshold_cents FROM user_prefs").get()!
        .threshold_cents,
      1234,
    );
    assert.equal(
      db.sqlite.prepare("SELECT count(*) AS n FROM wishlist").get()!.n,
      1,
    );
  } finally {
    db.close();
  }
});

test("distinguishes zero from missing prices and keeps null discount inheritance", () => {
  const db = testDatabase();
  try {
    const input: any = fixture();
    input.wishlist[0].price_at_add = null;
    input.wishlist[0].last_notified_price = "0.00";
    input.wishlist[0].min_discount_pct = null;
    input.user_prefs[0].price_threshold = "0.00";
    input.user_prefs[0].min_discount_pct = 100;
    db.sqlite.exec(generateImportSql(input));
    const row = db.sqlite.prepare("SELECT * FROM wishlist").get()!;
    assert.equal(row.price_at_add_cents, null);
    assert.equal(row.baseline_price_cents, 0);
    assert.equal(row.last_observed_price_cents, 0);
    assert.equal(row.min_discount_pct, null);
    assert.equal(
      db.sqlite.prepare("SELECT threshold_cents FROM user_prefs").get()!
        .threshold_cents,
      0,
    );
    assert.equal(
      db.sqlite.prepare("SELECT min_discount_pct FROM user_prefs").get()!
        .min_discount_pct,
      99,
    );
  } finally {
    db.close();
  }
});

test("falls back to added price when no observed price exists", () => {
  const db = testDatabase();
  try {
    const input: any = fixture();
    input.wishlist[0].last_notified_price = null;
    db.sqlite.exec(generateImportSql(input));
    assert.equal(
      db.sqlite.prepare("SELECT baseline_price_cents FROM wishlist").get()!
        .baseline_price_cents,
      10000,
    );
    assert.equal(
      db.sqlite.prepare("SELECT last_observed_price_cents FROM wishlist").get()!
        .last_observed_price_cents,
      null,
    );
  } finally {
    db.close();
  }
});

test("rejects malformed exports before producing SQL without revealing private records", () => {
  for (const mutate of [
    (x: any) => {
      x.version = 2;
    },
    (x: any) => {
      x.wishlist[0].price_at_add = "NaN";
    },
    (x: any) => {
      x.wishlist[0].price_at_add = "0.001";
    },
    (x: any) => {
      x.wishlist[0].price_at_add = -1;
    },
    (x: any) => {
      x.wishlist[0].price_at_add = 1.01;
    },
    (x: any) => {
      x.wishlist[0].user_id = 9007199254740992;
    },
    (x: any) => {
      x.wishlist[0].game_slug = "not-a-stable-uuid";
    },
    (x: any) => {
      x.wishlist[0].added_at = "2024-01-01";
    },
    (x: any) => {
      x.user_prefs[0].min_score = 101;
    },
    (x: any) => {
      x.wishlist.push({ ...x.wishlist[0], game_title: "conflicting" });
    },
    (x: any) => {
      x.wishlist[0].game_title = "🎮".repeat(50_000);
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(
      () => generateImportSql(input),
      (error: any) => error.message === "Invalid legacy export",
    );
  }
});

test("private SQL output cannot overwrite an existing backup", () => {
  const directory = mkdtempSync(join(tmpdir(), "itad-migration-"));
  try {
    const output = join(directory, "migration-private", "import.sql");
    writePrivateSql(output, "SELECT 1;\n");
    assert.throws(() => writePrivateSql(output, "SELECT 2;\n"));
    assert.equal(readFileSync(output, "utf8"), "SELECT 1;\n");
    assert.throws(() =>
      writePrivateSql(join(directory, "unsafe.sql"), "SELECT 1;"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("large exports produce D1-compatible statement sizes without dropping rows", () => {
  const db = testDatabase();
  try {
    const input: any = fixture();
    input.wishlist[0].game_title = "🎮".repeat(400);
    input.wishlist = Array.from({ length: 240 }, (_, index) => ({
      ...input.wishlist[0],
      user_id: String(index + 1),
    }));
    const sql = generateImportSql(input);
    for (const statement of sql
      .split("\n")
      .filter((line) => line.startsWith("INSERT"))) {
      assert.ok(Buffer.byteLength(statement, "utf8") < 100_000);
    }
    db.sqlite.exec(sql);
    assert.equal(
      db.sqlite.prepare("SELECT count(*) AS n FROM wishlist").get()!.n,
      240,
    );
  } finally {
    db.close();
  }
});

test("CLI produces executable private import SQL and prints counts only", () => {
  const directory = mkdtempSync(join(tmpdir(), "itad-migration-cli-"));
  const db = testDatabase();
  try {
    const input = join(directory, "fixture.json");
    const output = join(directory, "migration-private", "import.sql");
    writeFileSync(input, JSON.stringify(fixture()), "utf8");
    const stdout = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("../../scripts/migration/import_legacy.ts", import.meta.url),
        ),
        "--input",
        input,
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      stdout.trim(),
      "Import SQL prepared: wishlist=1 preferences=1 legacy_slugs=2",
    );
    db.sqlite.exec(readFileSync(output, "utf8"));
    assert.equal(
      db.sqlite.prepare("SELECT count(*) AS n FROM wishlist").get()!.n,
      1,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
