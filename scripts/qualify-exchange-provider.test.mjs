import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { qualifyExchangeProvider } from './qualify-exchange-provider.mjs';
const secret = 'synthetic-api-key-not-a-real-credential',
  rate = 'private-rate-do-not-retain';
const body = () => ({
  currency: 'sol',
  network: 'sol',
  fromAmount: '1.05',
  toAmount: '1',
  validUntil: new Date(Date.now() + 60000).toISOString(),
  rateId: rate,
  warningMessage: 'private untrusted provider notice',
});
async function retained(result) {
  const saved = JSON.parse(await readFile(resolve(result.path), 'utf8'));
  assert.deepEqual(saved, result.receipt);
  const text = JSON.stringify(saved);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(rate));
  assert.ok(!text.includes('private untrusted'));
  return saved;
}
test('missing key and refused CLI configuration leave startup receipts with zero network or authority', async () => {
  for (const options of [
    { liveReadOnly: true, payoutSol: '1' },
    { liveReadOnly: true, payoutSol: '1', runtimeVersion: '26.0.0' },
    { liveReadOnly: false, payoutSol: '1', key: secret },
    { liveReadOnly: true, payoutSol: 'not-an-amount', key: secret },
  ]) {
    const r = await qualifyExchangeProvider(options),
      saved = await retained(r);
    assert.equal(saved.passed, false);
    assert.equal(saved.providerRequests, 0);
    assert.equal(saved.stage, 'configuration');
    assert.equal(saved.liveQuoteQualified, false);
    assert.equal(saved.providerOrders, 0);
  }
});
test('one synthetic quote exercises actual quote/review/reload guards with no order or credential retention', async () => {
  let calls = 0;
  const r = await qualifyExchangeProvider({
      liveReadOnly: true,
      payoutSol: '1',
      key: secret,
      fetchImpl: async (url, init) => {
        calls++;
        assert.equal(
          new URL(url).pathname,
          '/v2/private-transfer/estimated-amount',
        );
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'manual');
        assert.equal(init.cache, 'no-store');
        assert.equal(
          new Headers(init.headers).get('x-changenow-api-key'),
          secret,
        );
        assert.equal(init.body, undefined);
        return Response.json(body());
      },
    }),
    saved = await retained(r);
  assert.equal(calls, 1);
  assert.equal(saved.passed, true);
  assert.equal(saved.liveQuoteQualified, false);
  assert.equal(saved.networkMode, 'injected-synthetic');
  assert.equal(saved.sourceUnchanged, true);
  assert.match(saved.executedBundleSha256, /^[a-f0-9]{64}$/);
  assert.equal(saved.reviewPrepared, true);
  assert.equal(saved.reviewReloadMatched, true);
  assert.equal(saved.quote.providerCostLamports, '50000000');
  for (const field of [
    'providerOrders',
    'approvals',
    'deposits',
    'signatures',
    'broadcasts',
  ])
    assert.equal(saved[field], 0);
  for (const field of [
    'orderCreationAllowed',
    'fundingAllowed',
    'signingAllowed',
    'executionAllowed',
    'productionConfigChanged',
  ])
    assert.equal(saved[field], false);
});
test('a first429 is retained as a refusal with one attempt and no retry or provider error text', async () => {
  let calls = 0;
  const r = await qualifyExchangeProvider({
      liveReadOnly: true,
      payoutSol: '1',
      key: secret,
      fetchImpl: async () => {
        calls++;
        return new Response('private untrusted ' + secret, { status: 429 });
      },
    }),
    saved = await retained(r);
  assert.equal(calls, 1);
  assert.equal(saved.passed, false);
  assert.equal(saved.httpStatus, 429);
  assert.equal(saved.serviceStatus, 429);
  assert.equal(saved.reviewPrepared, false);
  assert.equal(saved.quote, null);
});
test('a mismatched provider network never prepares a local review', async () => {
  const r = await qualifyExchangeProvider({
      liveReadOnly: true,
      payoutSol: '1',
      key: secret,
      fetchImpl: async () => Response.json({ ...body(), network: 'eth' }),
    }),
    saved = await retained(r);
  assert.equal(saved.httpStatus, 200);
  assert.equal(saved.serviceStatus, 502);
  assert.equal(saved.passed, false);
  assert.equal(saved.providerRequests, 1);
  assert.equal(saved.reviewPrepared, false);
  assert.equal(saved.liveQuoteQualified, false);
});

test('an unsafe body or redirect cannot turn the quote probe into another request', async () => {
  for (const response of [
    () => new Response('<html>private untrusted provider notice</html>'),
    () => new Response('x'.repeat(65537)),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://bad.test/' + secret },
      }),
  ]) {
    let calls = 0;
    const r = await qualifyExchangeProvider({
        liveReadOnly: true,
        payoutSol: '1',
        key: secret,
        fetchImpl: async () => {
          calls++;
          return response();
        },
      }),
      saved = await retained(r);
    assert.equal(calls, 1);
    assert.equal(saved.passed, false);
    assert.equal(saved.reviewPrepared, false);
    assert.equal(saved.providerOrders, 0);
  }
});
test('an exception carrying credentials is never copied into a refusal receipt', async () => {
  const r = await qualifyExchangeProvider({
      liveReadOnly: true,
      payoutSol: '1',
      key: secret,
      fetchImpl: async () => {
        throw Error('https://bad.test/' + secret + ' ' + rate);
      },
    }),
    saved = await retained(r);
  assert.equal(saved.passed, false);
  assert.equal(saved.providerRequests, 1);
  assert.equal(saved.reviewPrepared, false);
  assert.equal(saved.refusal, 'provider-or-quote-refused');
});
