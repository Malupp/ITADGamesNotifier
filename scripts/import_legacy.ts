import { readFileSync, openSync, closeSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, renameSync, fsyncSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;
const invalid = (): never => { throw new Error('Invalid legacy export'); };
function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Row;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) invalid(); return value as unknown[]; }
function text(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.includes('\0')) invalid();
  return value as string;
}
function userId(value: unknown): string {
  const id = text(value)!;
  if (!/^(?:0|-?[1-9]\d*)$/.test(id)) invalid();
  const n = BigInt(id);
  if (n < -(2n ** 63n) || n >= 2n ** 63n) invalid();
  return id;
}
function cents(value: unknown, fallback: number | null = null): number | null {
  if (value === null) return fallback;
  // PostgreSQL NUMERIC is exported as a decimal string. Never parse through
  // a floating-point euro amount or silently round fractional cents.
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) invalid();
  const [whole, fraction = ''] = (value as string).split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return Number(result);
}
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value as number;
}
function discount(value: unknown, nullable = false): number | null {
  if (value === null) return nullable ? null : 10;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid();
  return Math.max(10, Math.min(99, value as number));
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) invalid();
  const parsed = Date.parse(value as string);
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid();
  // Date.parse otherwise accepts invalid calendar days, silently rolling over.
  if (new Date(parsed).toISOString().slice(0, 19) !== (value as string).slice(0, 19)) invalid();
  return parsed;
}
function sqlRows(table: string, columns: string[], rows: Row[]): string {
  const chunks: string[] = [];
  const values = columns.map(column => `json_extract(value, '$.${column}')`).join(', ');
  const prefix = `INSERT INTO ${table} (${columns.join(', ')}) SELECT ${values} FROM json_each('[`;
  const suffix = `]') WHERE 1 ON CONFLICT DO NOTHING;`;
  const overhead = Buffer.byteLength(prefix + suffix, 'utf8');
  let fragments: string[] = [], bytes = overhead;
  const flush = () => {
    if (fragments.length) chunks.push(prefix + fragments.join(',') + suffix);
    fragments = []; bytes = overhead;
  };
  for (const row of rows) {
    const json = JSON.stringify(row).replaceAll("'", "''");
    const length = Buffer.byteLength(json, 'utf8');
    // Leave room under D1's SQL statement limit, including UTF-8 and quote
    // escaping. Reject an oversized single record before writing any file.
    if (overhead + length > 90_000) invalid();
    if (fragments.length >= 100 || bytes + length + 1 > 90_000) flush();
    bytes += length + (fragments.length ? 1 : 0);
    fragments.push(json);
  }
  flush();
  return chunks.join('\n');
}

export function generateImportSql(input: unknown): string {
  try {
    const source = record(input);
    if (source.version !== 1 || source.legacy_timestamp_timezone !== 'UTC') invalid();
    const exportedAt = timestamp(source.exported_at);
    const seenWishlist = new Set<string>();
    const wishlist = array(source.wishlist).map(value => {
      const row = record(value), user = userId(row.user_id), game = text(row.game_slug)!;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(game)) invalid();
      const normalizedGame = game.toLowerCase(), key = `${user}/${normalizedGame}`;
      if (seenWishlist.has(key)) invalid();
      seenWishlist.add(key);
      const addedPrice = cents(row.price_at_add), observed = cents(row.last_notified_price);
      return { user_id: user, game_id: normalizedGame, title: text(row.game_title), username: text(row.username, true),
        price_at_add_cents: addedPrice, baseline_price_cents: observed ?? addedPrice,
        baseline_origin: observed === null ? 'initial' : 'legacy_observed',
        last_observed_price_cents: observed, last_notified_price_cents: null,
        min_discount_pct: discount(row.min_discount_pct, true), last_shop: text(row.last_notified_shop, true),
        last_url: text(row.last_notified_url, true), added_at: row.added_at === null ? exportedAt : timestamp(row.added_at),
        last_observed_at: observed === null ? null : exportedAt, last_notified_at: null };
    });
    const seenUsers = new Set<string>();
    const prefs = array(source.user_prefs).map(value => {
      const row = record(value), user = userId(row.user_id);
      if (seenUsers.has(user)) invalid();
      seenUsers.add(user);
      return { user_id: user, username: text(row.username, true), threshold_cents: cents(row.price_threshold, 500),
        min_cut: boundedInteger(row.min_cut, 0, 0, 100), min_score: boundedInteger(row.min_score, 0, 0, 100),
        min_discount_pct: discount(row.min_discount_pct) };
    });
    const slugs = [...new Set(array(source.sent_deals).map(value => {
      const slug = text(value)!;
      if (!slug) invalid();
      return slug;
    }))].map(slug => ({ slug, imported_at: exportedAt }));
    return '-- Private legacy import v1. Retry safely; existing rows and delivered references are preserved.\n'
      + [sqlRows('user_prefs', ['user_id', 'username', 'threshold_cents', 'min_cut', 'min_score', 'min_discount_pct'], prefs),
        sqlRows('wishlist', ['user_id', 'game_id', 'title', 'username', 'price_at_add_cents', 'baseline_price_cents',
          'baseline_origin', 'last_observed_price_cents', 'last_notified_price_cents', 'min_discount_pct', 'last_shop',
          'last_url', 'added_at', 'last_observed_at', 'last_notified_at'], wishlist),
        sqlRows('legacy_sent_slugs', ['slug', 'imported_at'], slugs)].filter(Boolean).join('\n') + '\n';
  } catch { return invalid(); }
}

function secure(path: string, directory = false): void {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (!user) throw new Error('Private output unavailable');
    const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
    execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${principal}:F`], { stdio: 'pipe' });
  } else chmodSync(path, directory ? 0o700 : 0o600);
}

export function writePrivateSql(outputPath: string, sql: string): void {
  const output = resolve(outputPath), parent = dirname(output);
  if (!parent.split(sep).includes('migration-private')) throw new Error('Private output unavailable');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  secure(parent, true);
  closeSync(openSync(output, 'wx', 0o600));
  const temporary = resolve(parent, `.import-${randomUUID()}.tmp`);
  let completed = false;
  try {
    secure(output);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      secure(temporary);
      writeFileSync(fd, sql, 'utf8');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, output);
    completed = true;
  } finally {
    if (!completed) {
      try { unlinkSync(temporary); } catch { /* may not have been created */ }
      unlinkSync(output);
    }
  }
}

export function main(argv = process.argv.slice(2)): number {
  try {
    if (argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--output') throw new Error('Arguments');
    const input = JSON.parse(readFileSync(resolve(argv[1]), 'utf8'));
    const sql = generateImportSql(input);
    writePrivateSql(argv[3], sql);
    console.log(`Import SQL prepared: wishlist=${input.wishlist.length} preferences=${input.user_prefs.length} legacy_slugs=${new Set(input.sent_deals).size}`);
    return 0;
  } catch {
    console.error('Import preparation failed; validate the export and a new migration-private output path.');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
