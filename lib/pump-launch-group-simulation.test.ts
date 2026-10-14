import { expect, it } from 'vitest';
import { pumpLaunchGroupSimulationFixture as fixture } from '../test/pump-launch-group-simulation-fixture';
import type { PumpLaunchRpc } from './pump-launch-simulation';

for (const [stock, token22] of [
  [false, false],
  [true, false],
  [true, true],
])
  it(`collects one complete replay, rent and final sources (${stock},${token22})`, async () => {
    const f = await fixture(stock, token22),
      result = await f.run();
    expect(result).toMatchObject({
      manifestSha256: f.group.manifestSha256,
      replayCount: 1,
      settlementValidated: true,
      rpcCollectionRequired: false,
      programDeploymentReviewRequired: true,
      programDeploymentMetadataValidated: true,
      programDeploymentMetadataOnly: true,
      programCodeAttested: false,
      transportReviewRequired: true,
      signingAllowed: false,
      executionAllowed: false,
      completeLaunch: false,
    });
    expect(result.accounting).toMatchObject({
      economicPrefixesValidated: true,
      fullGroupAccountingValidated: true,
      rpcCollectionRequired: false,
    });
    expect(
      f.calls.filter((call) => call.method === 'simulateBundle'),
    ).toHaveLength(1);
    expect(
      f.calls.find((call) => call.method === 'simulateBundle')!.params[0],
    ).toEqual({
      encodedTransactions: f.group.packets.map((packet) => packet.transaction),
    });
    expect(
      f.calls.every(
        (call) => !/send|sign|simulateTransaction/i.test(call.method),
      ),
    ).toBe(true);
    const sizes = f.calls
      .filter((call) => call.method === 'getMinimumBalanceForRentExemption')
      .map((call) => call.params[0]);
    expect(sizes.length).toBeGreaterThan(0);
    expect(new Set(sizes).size).toBe(sizes.length);
    expect(result.reads).toBe(f.calls.length);
  }, 15000);
it('binds upgradeable deployment metadata before and after complete replay', async () => {
  const f = await fixture(false, false, true),
    result = await f.run();
  expect(result.programDeploymentHashes).toEqual(
    f.creation.programDeploymentHashes,
  );
  expect(
    f.calls.filter(
      (call) =>
        call.method === 'getMultipleAccounts' &&
        (call.params[1] as { dataSlice?: unknown }).dataSlice,
    ),
  ).toHaveLength(2);
}, 15000);
it('rejects deployment changes after replay', async () => {
  const f = await fixture(false, false, true);
  f.state.changeDeployment = true;
  await expect(f.run()).rejects.toThrow(
    'deployment changed during verification',
  );
}, 15000);
it('rejects mismatched creation deployment hashes before replay', async () => {
  const f = await fixture(false, false, true);
  f.creation.programDeploymentHashes[0].sha256 = 'f'.repeat(64);
  await expect(f.run()).rejects.toThrow('deployment changed after creation');
  expect(
    f.calls.filter((call) => call.method === 'simulateBundle'),
  ).toHaveLength(0);
}, 15000);
it('rejects unsupported rent rather than trusting supplied fixture economics', async () => {
  const f = await fixture();
  f.state.rent = '2000000';
  await expect(f.run()).rejects.toThrow();
}, 15000);
it('rejects expired or malformed evidence before any provider request', async () => {
  const f = await fixture();
  for (const expiresAt of [
    'invalid',
    new Date(Date.now() - 1).toISOString(),
    new Date(Date.now() + 120000).toISOString(),
  ]) {
    f.creation.expiresAt = expiresAt;
    await expect(f.run()).rejects.toThrow('invalid lifetime');
  }
  expect(f.calls).toHaveLength(0);
});
it('rechecks sources after rent and economic verification', async () => {
  const f = await fixture();
  f.state.changeSource = true;
  await expect(f.run()).rejects.toThrow('source changed during economic');
}, 15000);
it('rechecks original lifetime and network after economics', async () => {
  const f = await fixture();
  f.state.expired = true;
  await expect(f.run()).rejects.toThrow('lifetime expired after accounting');
  const g = await fixture();
  g.state.networkChanged = true;
  await expect(g.run()).rejects.toThrow('provider network changed');
}, 15000);
it('races cancellation even when the rent provider ignores abort', async () => {
  const f = await fixture(),
    abort = new AbortController();
  const provider: PumpLaunchRpc = async (method, params, signal) => {
    if (method === 'getMinimumBalanceForRentExemption') {
      setTimeout(() => abort.abort(new Error('Rent cancelled')), 10);
      return new Promise(() => {});
    }
    return f.rpc(method, params, signal);
  };
  await expect(f.run(provider, abort.signal)).rejects.toThrow('Rent cancelled');
  expect(
    f.calls.filter((call) => call.method === 'simulateBundle'),
  ).toHaveLength(1);
}, 15000);
