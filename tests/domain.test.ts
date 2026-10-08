import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, isMeaningfulDrop, normalizeGiveaways, formatGiveaway } from '../src/domain.ts';
import type { PriceQuote } from '../src/types.ts';

const quote = (cents: number): PriceQuote => ({ gameId: 'g', shop: 'GOG', shopId: 35,
  url: 'https://www.gog.com/game/test', priceCents: cents, regularCents: 10000,
  cut: 100 - cents / 100, currency: 'EUR', expiry: null });

test('additional 10% drop uses confirmed delivery reference, not initial discount', () => {
  assert.equal(isMeaningfulDrop(10000, quote(9000), 10), true);
  assert.equal(isMeaningfulDrop(9000, quote(8900), 10), false);
  assert.equal(isMeaningfulDrop(9000, quote(8100), 10), true);
  assert.equal(isMeaningfulDrop(10000, quote(9040), 10), false);
});
test('zero prices remain valid; missing reference and price increases do not alert', () => {
  assert.equal(toCents('0.00'), 0);
  assert.equal(toCents(null), null);
  assert.equal(toCents('19.99'), 1999);
  assert.equal(toCents(0.1), 10);
  assert.equal(toCents('0.009'), null);
  assert.equal(toCents(Number.NaN), null);
  assert.equal(isMeaningfulDrop(null, quote(5000), 10), false);
  assert.equal(isMeaningfulDrop(0, quote(0), 10), false);
  assert.equal(isMeaningfulDrop(8000, quote(9000), 10), false);
  assert.equal(isMeaningfulDrop(1000, quote(0), 10), true);
});
test('a price change without an actual sale or in another currency does not alert', () => {
  assert.equal(isMeaningfulDrop(10000, { ...quote(8000), cut: 0, regularCents: 8000 }, 10), false);
  assert.equal(isMeaningfulDrop(10000, { ...quote(8000), regularCents: null }, 10), false);
  assert.equal(isMeaningfulDrop(10000, { ...quote(8000), currency: 'USD' }, 10), false);
  assert.equal(isMeaningfulDrop(10000, quote(9900), 1), false);
});

const now = Date.parse('2026-10-08T12:00:00Z');
const raw = (patch: Record<string, unknown> = {}) => ({ id: 123, title: 'Test giveaway',
  shop: { id: 35, name: 'GOG' }, url: 'https://www.gog.com/game/test', expiry: '2026-10-10T12:00:00Z', note: null,
  games: [{ id: '018d937f-07fc-72ed-8517-d8e24cb1eb22', slug: 'test', title: 'Test & Game', type: 'game', platforms: [{ id: 1, name: 'Windows' }] }], ...patch });

test('giveaway identity tracks campaign and game; duplicate source records collapse', () => {
  const offers = normalizeGiveaways([raw(), raw(), raw({ id: 124 })], now);
  assert.deepEqual(offers.map(x => x.id), [
    'itad:123:018d937f-07fc-72ed-8517-d8e24cb1eb22',
    'itad:124:018d937f-07fc-72ed-8517-d8e24cb1eb22',
  ]);
});
test('subscription, expired, DLC, trial and non-PC promotions are excluded', () => {
  const bad = [raw({ shop: { name: 'Amazon Prime' } }), raw({ expiry: '2026-10-07T12:00:00Z' }),
    raw({ expiry: 'invalid-date' }), raw({ note: 'Free weekend only' }), raw({ url: 'javascript:alert(1)' }),
    raw({ games: [{ id: 'dlc', type: 'dlc', platforms: [{ id: 1 }] }] }),
    raw({ games: [{ id: 'mobile', type: 'game', platforms: [{ id: 9, name: 'Android' }] }] })];
  assert.deepEqual(normalizeGiveaways(bad, now), []);
});
test('messages escape source HTML and show expiry in Rome timezone', () => {
  const offer = normalizeGiveaways([raw()], now)[0];
  const text = formatGiveaway(offer);
  assert.match(text, /Test &amp; Game/);
  assert.match(text, /14:00/);
  assert.doesNotMatch(text, /undefined/);
});

test('unknown regional, paid membership, F2P and mobile conditions fail closed', () => {
 for (const note of ['Only available in United States','Requires an active paid membership','F2P permanently free','Only Android accounts']) assert.deepEqual(normalizeGiveaways([raw({note})],now),[]);
});
