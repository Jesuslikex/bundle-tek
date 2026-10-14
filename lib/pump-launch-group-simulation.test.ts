import { expect, it } from 'vitest';
import { getCompiledTransactionMessageDecoder } from '@solana/kit-v1';
import { pumpLaunchGroupSettlementFixture } from '../test/pump-launch-group-settlement-fixture';
import { collectPumpLaunchGroupFunding } from './pump-holder-funding';
import { collectPumpLaunchGroupSimulation } from './pump-launch-group-simulation';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';

async function fixture(stock = false, token22 = false, upgradeable = false) {
  const f = await pumpLaunchGroupSettlementFixture(
    stock,
    token22,
    true,
    true,
    upgradeable,
  );
  const calls: { method: string; params: unknown[] }[] = [];
  const state = {
    rent: '1000000',
    afterRent: false,
    changeSource: false,
    expired: false,
    networkChanged: false,
    changeDeployment: false,
  };
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    calls.push({ method, params });
    if (method === 'getGenesisHash')
      return state.afterRent && state.networkChanged
        ? 'other'
        : SOLANA_MAINNET_GENESIS;
    if (method === 'getFeeForMessage')
      return {
        context: { slot: '100' },
        value: (
          BigInt(
            getCompiledTransactionMessageDecoder().decode(
              Buffer.from(params[0] as string, 'base64'),
            ).header.numSignerAccounts,
          ) * 5000n
        ).toString(),
      };
    if (method === 'simulateBundle') return structuredClone(f.response);
    if (
      method === 'getMultipleAccounts' &&
      (params[1] as { dataSlice?: unknown })?.dataSlice
    ) {
      const result = (await f.f.rpc(method, params, signal)) as {
        context: { slot: string };
        value: { data: [string, 'base64'] }[];
      };
      if (state.changeDeployment && state.afterRent) {
        const bytes = Buffer.from(result.value[0].data[0], 'base64');
        bytes[13] ^= 1;
        result.value[0].data[0] = bytes.toString('base64');
      }
      return result;
    }
    if (method === 'getMultipleAccounts')
      return {
        context: { slot: '100' },
        value: (params[0] as string[]).map((address) => {
          const account = structuredClone(f.before.get(address) ?? null);
          if (
            state.afterRent &&
            state.changeSource &&
            address === f.input.create.payer &&
            account
          )
            account.lamports = (BigInt(account.lamports) - 1n).toString();
          return account;
        }),
      };
    if (method === 'getMinimumBalanceForRentExemption') {
      state.afterRent = true;
      return state.rent;
    }
    if (method === 'isBlockhashValid')
      return { context: { slot: '100' }, value: true };
    if (method === 'getBlockHeight')
      return state.afterRent && state.expired ? '995' : '900';
    throw new Error('Unexpected provider method');
  };
  const funding = await collectPumpLaunchGroupFunding(
    f.input,
    f.limits,
    {
      minimumSlot: 100,
      maximumSlot: 100,
      accountHashes: f.evidence.creationAccountHashes,
    },
    new AbortController().signal,
    rpc,
  );
  calls.length = 0;
  const creation = {
    accountHashes: f.evidence.creationAccountHashes,
    programDeploymentHashes: structuredClone(
      f.creation.simulation.programDeploymentHashes,
    ),
    expiresAt: new Date(Date.now() + 59000).toISOString(),
  };
  const run = (provider = rpc, signal = new AbortController().signal) =>
    collectPumpLaunchGroupSimulation(
      f.input,
      f.limits,
      funding,
      creation,
      signal,
      provider,
    );
  return { ...f, funding, creation, rpc, calls, state, run };
}
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
