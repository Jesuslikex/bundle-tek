import test from 'node:test';
import assert from 'node:assert/strict';
import { stockClockWire, captureStockClockWire } from './stock-clock-wire.mjs';
const clock = 'SysvarC1ock11111111111111111111111111111111';
const request = {
  id: 1,
  method: 'getMultipleAccounts',
  params: [[clock, clock], { commitment: 'confirmed', minContextSlot: 100 }],
};
function account(slot) {
  const bytes = Buffer.alloc(40);
  bytes.writeBigUInt64LE(BigInt(slot));
  bytes.writeBigInt64LE(1792166400n, 32);
  return { data: [bytes.toString('base64'), 'base64'] };
}
const reply = () => ({
  jsonrpc: '2.0',
  id: 1,
  result: { context: { slot: 100 }, value: [account(101), account(102)] },
});
test('retains raw Clock/context disagreement and separate duplicate-account bytes without changing the response', async () => {
  const text = JSON.stringify(reply()),
    response = new Response(text);
  const observations = await captureStockClockWire(
    response,
    request,
    () => 123,
  );
  assert.deepEqual(
    observations.map((r) => [r.contextSlot, r.clockSlot, r.accountIndex]),
    [
      ['100', '101', 0],
      ['100', '102', 1],
    ],
  );
  assert.notEqual(
    observations[0].clockDataSha256,
    observations[1].clockDataSha256,
  );
  assert.equal(observations[0].requestedFloor, 100);
  assert.equal(observations[0].receivedServerTimeMs, 123);
  assert.equal(await response.text(), text);
});
test('matches raw batch ids without treating observation as transport acceptance', () => {
  const req = { ...request, id: 2 };
  assert.equal(
    stockClockWire(
      [request, req],
      JSON.stringify([{ ...reply(), id: 2 }, reply()]),
      123,
    ).length,
    4,
  );
  assert.throws(
    () => stockClockWire(request, JSON.stringify([reply(), reply()]), 123),
    /identity/,
  );
  assert.throws(() => stockClockWire(request, '{}', 123), /identity/);
});
test('does not consume unrelated responses or hide malformed Clock evidence', async () => {
  const response = new Response('unparsed provider body');
  assert.deepEqual(
    await captureStockClockWire(response, { method: 'getSlot' }),
    [],
  );
  assert.equal(await response.text(), 'unparsed provider body');
  const bad = reply();
  bad.result.value[0].data[0] = '';
  assert.throws(
    () => stockClockWire(request, JSON.stringify(bad), 123),
    /bytes/,
  );
});
test('bounds diagnostic copying while preserving the original oversized response', async () => {
  const response = new Response('x'.repeat(2097153));
  await assert.rejects(captureStockClockWire(response, request), /bound/);
  assert.equal((await response.text()).length, 2097153);
});
