import { expect, it } from 'vitest';
import { pumpHolderSettlementFixture } from '../test/pump-holder-settlement-fixture';
import { collectPumpHolderFunding } from './pump-holder-funding';
import { simulatePumpHolderPacket } from './pump-holder-simulation';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';

async function fixture(stock = false, token22 = false, upgradeable = false) {
  const f = await pumpHolderSettlementFixture(
    stock,
    token22,
    true,
    true,
    upgradeable,
  );
  const state = {
    err: null as unknown,
    fee: '20000',
    valid: true,
    units: '600000',
    loaded: '1048576',
    replacement: null as unknown,
    changed: false,
    slot: '100',
    simulations: 0,
    deploymentChanged: false,
    hook: () => {},
  };
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    signal.throwIfAborted();
    calls.push({ method, params });
    const context = { slot: state.slot };
    if (
      method === 'getMultipleAccounts' &&
      (params[1] as { dataSlice?: unknown }).dataSlice
    ) {
      const result = structuredClone(await f.f.rpc(method, params, signal)) as {
        context: { slot: string };
        value: { data: [string, string] }[];
      };
      if (state.deploymentChanged)
        for (const a of result.value) {
          const b = Buffer.from(a.data[0], 'base64');
          b[4] ^= 1;
          a.data[0] = b.toString('base64');
        }
      return result;
    }
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getMultipleAccounts')
      return {
        context,
        value: (params[0] as string[]).map((key) => {
          const i = f.evidence.addresses.indexOf(key),
            account = structuredClone(f.evidence.before[i]);
          if (state.changed && key === f.input.holders[0].address && account)
            (account as { lamports: string }).lamports = '1';
          return account;
        }),
      };
    if (method === 'getFeeForMessage') return { context, value: state.fee };
    if (method === 'getMinimumBalanceForRentExemption') return '1000000';
    if (method === 'getBlockHeight') return '900';
    if (method === 'isBlockhashValid') return { context, value: state.valid };
    if (method === 'simulateTransaction') {
      state.simulations++;
      state.hook();
      return {
        context,
        value: {
          err: state.err,
          fee: state.fee,
          unitsConsumed: state.units,
          loadedAccountsDataSize: state.loaded,
          replacementBlockhash: state.replacement,
          accounts: structuredClone(f.evidence.after),
        },
      };
    }
    throw new Error('Unexpected holder RPC method: ' + method);
  };
  const funding = await collectPumpHolderFunding(
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
    programDeploymentHashes: f.creation.simulation.programDeploymentHashes,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const run = () =>
    simulatePumpHolderPacket(
      f.input,
      f.limits,
      funding,
      creation,
      new AbortController().signal,
      rpc,
    );
  return { ...f, state, calls, funding, creation, rpc, run };
}
for (const [stock, token22] of [
  [false, false],
  [true, false],
  [true, true],
])
  it(`collects and verifies the complete unsigned holder simulation (${stock}, token22=${token22})`, async () => {
    const f = await fixture(stock, token22),
      result = await f.run();
    expect(result).toMatchObject({
      status: 'Simulated',
      settlementValidated: true,
      programDeploymentMetadataOnly: true,
      signingAllowed: false,
      executionAllowed: false,
      completeLaunch: false,
      packetSha256: f.packet.packetSha256,
    });
    expect(result.accounting.wallets).toHaveLength(3);
    expect(result.accountHashes).toHaveLength(f.packet.accountCount);
    const simulate = f.calls.find((c) => c.method === 'simulateTransaction')!;
    expect(simulate.params).toEqual([
      f.packet.transaction,
      expect.objectContaining({
        sigVerify: false,
        replaceRecentBlockhash: false,
        accounts: { encoding: 'base64', addresses: f.evidence.addresses },
      }),
    ]);
    expect(f.state.simulations).toBe(1);
    expect(f.calls.some((c) => /send|sign|bundle/i.test(c.method))).toBe(false);
  });
it('rejects modified funding bindings before provider reads', async () => {
  const f = await fixture();
  f.funding.packetSha256 = '0'.repeat(64);
  await expect(f.run()).rejects.toThrow('funding context');
  expect(f.calls).toEqual([]);
});
it('binds upgradeable deployment metadata and detects changes before and during simulation', async () => {
  const f = await fixture(false, false, true),
    result = await f.run();
  expect(result.programDeploymentHashes).toHaveLength(1);
  expect(result.programDeploymentMetadataOnly).toBe(true);
  const g = await fixture(false, false, true);
  g.state.deploymentChanged = true;
  await expect(g.run()).rejects.toThrow('changed after creation');
  const h = await fixture(false, false, true);
  h.state.hook = () => {
    h.state.deploymentChanged = true;
  };
  await expect(h.run()).rejects.toThrow('program changed during');
});
it('rejects simulation errors, replacement lifetime and resource overflow', async () => {
  for (const patch of [
    { err: { InstructionError: [1, 'Custom'] } },
    { replacement: {} },
    { units: '1400001' },
    { loaded: '67108865' },
  ]) {
    const f = await fixture();
    Object.assign(f.state, patch);
    await expect(f.run()).rejects.toThrow();
  }
});
it('does not accept simulated provider success with a missing holder output', async () => {
  const f = await fixture();
  f.evidence.after[
    f.evidence.addresses.indexOf(f.packet.buyerAccounts[2].userBaseAccount)
  ] = null;
  await expect(f.run()).rejects.toThrow();
});
it('rejects source changes before or during simulation', async () => {
  const f = await fixture();
  f.state.changed = true;
  await expect(f.run()).rejects.toThrow('funding changed');
  expect(f.state.simulations).toBe(0);
  const g = await fixture();
  g.state.hook = () => {
    g.state.changed = true;
  };
  await expect(g.run()).rejects.toThrow('state changed during');
});
it('rejects changed fee, expired observations, invalid blockhash and stale contexts', async () => {
  const f = await fixture();
  f.state.fee = '25000';
  await expect(f.run()).rejects.toThrow('network fee changed');
  const g = await fixture();
  g.creation.expiresAt = new Date(0).toISOString();
  await expect(g.run()).rejects.toThrow('observation expired');
  expect(g.calls).toEqual([]);
  const h = await fixture();
  h.state.valid = false;
  await expect(h.run()).rejects.toThrow('blockhash');
  const i = await fixture();
  i.state.slot = '99';
  await expect(i.run()).rejects.toThrow('context slot');
});
