import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Real SQLite underneath the D1-shaped boundary; network services alone are faked.
export function testDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_scans.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_dispatch.sql', import.meta.url), 'utf8'));
  function prepare(sql: string, values: unknown[] = []): any {
    return {
      bind(...args: unknown[]) { return prepare(sql, args); },
      async first(column?: string) {
        const row = sqlite.prepare(sql).get(...values as any[]) as Record<string, unknown> | undefined;
        return column ? row?.[column] ?? null : row ?? null;
      },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...values as any[]), meta: {} }; },
      async run() {
        const result = sqlite.prepare(sql).run(...values as any[]);
        return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      async raw() { return sqlite.prepare(sql).all(...values as any[]).map(row => Object.values(row)); },
    };
  }
  const db: any = {
    prepare,
    async batch(statements: any[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    async exec(sql: string) { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
  return { db: db as D1Database, sqlite, close: () => sqlite.close() };
}
