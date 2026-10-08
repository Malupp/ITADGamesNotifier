import test from 'node:test';
import assert from 'node:assert/strict';
import { processJob } from '../src/worker.ts';
import { Store } from '../src/store.ts';
import { Scans } from '../src/scans.ts';
import { testDatabase } from './sqlite.ts';
import type { Env, PriceQuote, QueueJob } from '../src/types.ts';

const game = { id: '018d937f-07fc-72ed-8517-d8e24cb1eb22', slug: 'game', title: 'Game', type: 'game' };
const quote = (priceCents: number, shop = 'GOG', shopId = 35, url = 'https://www.gog.com/game/old_offer'): PriceQuote => ({
  gameId: game.id, shop, shopId, url, priceCents, regularCents: 10000,
  cut: 100 - priceCents / 100, currency: 'EUR', expiry: null,
});
const json = (data: unknown) => new Response(JSON.stringify(data));
const apiQuote = (q: PriceQuote) => ({ shop: { id: q.shopId, name: q.shop }, url: q.url,
  price: { amountInt: q.priceCents, currency: q.currency },
  regular: { amountInt: q.regularCents, currency: q.currency }, cut: q.cut, expiry: null });
function setup() {
  const t = testDatabase();
  const jobs: QueueJob[] = [];
  const env = { DB: t.db, WORK_QUEUE: {
    send: async (body: QueueJob) => { jobs.push(body); },
    sendBatch: async (items: { body: QueueJob }[]) => { jobs.push(...items.map(item => item.body)); },
  }, SCANS_ENABLED: 'true', ITAD_API_KEY: 'fixture', TELEGRAM_BOT_TOKEN: 'fixture',
    TELEGRAM_WEBHOOK_SECRET: 'fixture', TELEGRAM_CHAT_ID: '1' } as unknown as Env;
  return { ...t, env, jobs, store: new Store(t.db), scans: new Scans(t.db) };
}

test('quiet seeding with confirmed delivery history creates no price notification', async () => {
  const t = setup(), now = Date.now();
  try {
    await t.store.addWishlist('1', null, game, quote(10000), now);
    await t.store.ingestPrices([quote(9000)], now + 1);
    const [id] = await t.store.pendingDeliveries(now + 1);
    const delivery = await t.store.claimDelivery(id, now + 1);
    assert.ok(delivery);
    await t.store.completeDelivery(delivery, now + 2);
    await t.store.ingestPrices([quote(7000)], now + 3, true);
    assert.deepEqual(await t.store.pendingDeliveries(now + 3), []);
    assert.equal((await t.store.getWishlist('1'))[0].last_notified_price_cents, 9000);
  } finally { t.close(); }
});

test('completed giveaway page recovers failed successor publication before the next cron', async () => {
  const t = setup(), now = Date.now();
  try {
    await t.scans.start('giveaways', [{ kind: 'giveaways', offset: 0, startedAt: now, baseline: true }], true, now);
    const [id] = await t.scans.pending(now);
    let publishFails = true;
    t.env.WORK_QUEUE.send = async body => {
      if (publishFails) { publishFails = false; throw new Error('fixture publication failure'); }
      t.jobs.push(body);
      return {metadata:{}} as QueueSendResponse;
    };
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/giveaways/v1');
      return json(url.searchParams.get('offset') === '0'
        ? Array.from({ length: 5 }, (_, index) => ({ id: index, games: [] })) : []);
    };
    assert.equal(await processJob({ kind: 'scan', id }, t.env, now, fetcher), 60);
    assert.equal(t.sqlite.prepare('SELECT status FROM scan_jobs WHERE id=?').get(id)!.status, 'done');
    assert.equal(await processJob({ kind: 'scan', id }, t.env, now + 60001, fetcher), null);
    const successor = t.jobs.find(job => job.kind === 'scan' && job.id !== id);
    assert.ok(successor, 'the durable successor must be published by the source replay');
    await processJob(successor, t.env, now + 60002, fetcher);
    assert.equal(await t.store.getSetting('giveaways_seeded'), 'true');
    assert.equal(t.sqlite.prepare('SELECT status FROM scan_runs').get()!.status, 'done');
  } finally { t.close(); }
});

test('giveaway delivery discards a campaign whose Italian store price is now paid', async () => {
  const t = setup(), now = Date.now();
  try {
    await t.store.ingestGiveaways([{ id: `itad:123:${game.id}`, gameId: game.id, slug: game.slug,
      title: game.title, shop: 'Steam', url: 'https://store.steampowered.com/app/123/', expiry: now + 3600000 }], ['1'], now, false);
    const [id] = await t.store.pendingDeliveries(now);
    const sent: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.telegram.org') {
        sent.push(JSON.parse(String(init?.body)).text);
        return json({ ok: true, result: {} });
      }
      assert.equal(url.pathname, '/games/prices/v3');
      return json([{ id: game.id, deals: [apiQuote(quote(10000, 'Steam', 61, 'https://store.steampowered.com/app/123/'))] }]);
    };
    await processJob({ kind: 'delivery', id }, t.env, now, fetcher);
    assert.deepEqual(sent, []);
    assert.equal(t.sqlite.prepare('SELECT status FROM deliveries WHERE id=?').get(id)!.status, 'expired');
  } finally { t.close(); }
});

test('price delivery uses the current shop and link when the same price moves to another shop', async () => {
  const t = setup(), now = Date.now();
  try {
    await t.store.addWishlist('1', null, game, quote(10000), now);
    await t.store.ingestPrices([quote(8000)], now + 1);
    const [id] = await t.store.pendingDeliveries(now + 1);
    const current = quote(8000, 'Steam', 61, 'https://store.steampowered.com/app/123/');
    const sent: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.telegram.org') {
        sent.push(JSON.parse(String(init?.body)).text);
        return json({ ok: true, result: {} });
      }
      assert.equal(url.pathname, '/games/prices/v3');
      return json([{ id: game.id, deals: [apiQuote(current)] }]);
    };
    await processJob({ kind: 'delivery', id }, t.env, now + 1, fetcher);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Steam/);
    assert.ok(sent[0].includes(current.url));
    assert.ok(!sent[0].includes('https://www.gog.com/game/old_offer'));
    assert.equal(t.sqlite.prepare('SELECT status FROM deliveries WHERE id=?').get(id)!.status, 'sent');
    assert.equal((await t.store.getWishlist('1'))[0].last_notified_price_cents, 8000);
  } finally { t.close(); }
});
