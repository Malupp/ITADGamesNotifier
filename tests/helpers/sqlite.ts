import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

// Real SQLite underneath the D1-shaped boundary; network services alone are faked.
export function testDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  function prepare(sql: string, values: unknown[] = []): any {
    return {
      bind(...args: unknown[]) {
        return prepare(sql, args);
      },
      async first(column?: string) {
        const row = sqlite.prepare(sql).get(...(values as any[])) as
          | Record<string, unknown>
          | undefined;
        return column ? (row?.[column] ?? null) : (row ?? null);
      },
      async all() {
        return {
          success: true,
          results: sqlite.prepare(sql).all(...(values as any[])),
          meta: {},
        };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...(values as any[]));
        return {
          success: true,
          results: [],
          meta: {
            changes: Number(result.changes),
            last_row_id: Number(result.lastInsertRowid),
          },
        };
      },
      async raw() {
        return sqlite
          .prepare(sql)
          .all(...(values as any[]))
          .map((row) => Object.values(row));
      },
    };
  }
  const db: any = {
    prepare,
    async batch(statements: any[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return { db: db as D1Database, sqlite, close: () => sqlite.close() };
}
