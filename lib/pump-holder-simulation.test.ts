import { expect, it } from 'vitest';
import { pumpHolderSettlementFixture } from '../test/pump-holder-settlement-fixture';
import { collectPumpHolderFunding } from './pump-holder-funding';
import { simulatePumpHolderPacket } from './pump-holder-simulation';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { pumpAccountBytes } from './pump-launch-simulation';
import { pumpHolderSourceHash } from './pump-holder-source';
import type { PumpLaunchRpc, PumpRpcAccount } from './pump-launch-simulation';

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
    recipientCredit: 0n,
    snapshots: 0,
    sourceHook: (_snapshot: number) => {},
    slot: '100',
    simulations: 0,
    deploymentChanged: false,
    hook: () => {},
  };
  const credited = (
    key: string,
    account: (typeof f.evidence.before)[number],
  ) => {
    if (
      account &&
      f.packet.buyerAccounts.some((b) => b.buybackAccount === key)
    ) {
      const a = account as NonNullable<PumpRpcAccount>;
      if (stock) {
        const bytes = pumpAccountBytes(a),
          view = new DataView(bytes.buffer);
        view.setBigUint64(
          64,
          view.getBigUint64(64, true) + state.recipientCredit,
          true,
        );
        a.data[0] = Buffer.from(bytes).toString('base64');
      } else
        a.lamports = (BigInt(a.lamports) + state.recipientCredit).toString();
    }
    return account;
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
    if (method === 'getMultipleAccounts') {
      state.sourceHook(++state.snapshots);
      return {
        context,
        value: (params[0] as string[]).map((key) => {
          const i = f.evidence.addresses.indexOf(key),
            account = structuredClone(f.evidence.before[i]);
          if (state.changed && key === f.input.holders[0].address && account)
            (account as { lamports: string }).lamports = '1';
          return credited(key, account);
        }),
      };
    }
    if (method === 'getFeeForMessage') return { context, value: state.fee };
    if (method === 'getMinimumBalanceForRentExemption') return '1000000';
    if (method === 'getBlockHeight') return '900';
    if (method === 'isBlockhashValid') return { context, value: state.valid };
    if (method === 'simulateTransaction') {
      state.simulations++;
      state.hook();
      return {
        context: { slot: state.slot },
        value: {
          err: state.err,
          fee: state.fee,
          unitsConsumed: state.units,
          loadedAccountsDataSize: state.loaded,
          replacementBlockhash: state.replacement,
          accounts: f.evidence.after.map((a, i) =>
            credited(f.evidence.addresses[i], structuredClone(a)),
          ),
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

for (const [stock, token22] of [
  [false, false],
  [true, false],
  [true, true],
])
  it(`keeps fee settlement exact after unrelated recipient credits (${stock}, token22=${token22})`, async () => {
    const f = await fixture(stock, token22),
      original = await f.run();
    const key = f.packet.buyerAccounts[0].buybackAccount;
    // Existing stock custody is needed to distinguish balance drift from changed ATA/rent existence.
    if (stock) {
      const index = f.evidence.addresses.indexOf(key);
      const post = structuredClone(
        f.evidence.after[index],
      ) as NonNullable<PumpRpcAccount>;
      const bytes = Buffer.from(post.data[0], 'base64');
      new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).setBigUint64(64, 0n, true);
      post.data[0] = bytes.toString('base64');
      f.evidence.before[index] = post;
      f.funding.accountHashes[index].sourceIdentitySha256 =
        await pumpHolderSourceHash(
          f.packet,
          key,
          post as Parameters<typeof pumpHolderSourceHash>[2],
        );
      // The first buyer no longer funds this existing account.
      const payerIndex = f.evidence.addresses.indexOf(
        f.packet.buyerAccounts[0].payer,
      );
      const payer = f.evidence.after[payerIndex] as NonNullable<PumpRpcAccount>;
      payer.lamports = (BigInt(payer.lamports) + 1000000n).toString();
    }
    const baseline = await f.run();
    f.state.recipientCredit = 1234567n;
    const result = await f.run();
    expect(result.accounting).toEqual(baseline.accounting);
    const a = result.accountHashes.find((a) => a.address === key)!;
    const b = baseline.accountHashes.find((a) => a.address === key)!;
    expect(a.beforeSha256).not.toBe(b.beforeSha256);
    expect(a.simulatedSha256).not.toBe(b.simulatedSha256);
    expect(a.sourceIdentitySha256).toBe(b.sourceIdentitySha256);
    expect(a.simulatedIdentitySha256).toBe(b.simulatedIdentitySha256);
    expect(result.sourceBankMatched).toBe(true);
    expect(original.packetSha256).toBe(result.packetSha256);
  });
it('retries a bank rollover and uses its new recipient baseline without counting external credits as fees', async () => {
  const f = await fixture(),
    baseline = await f.run();
  f.state.simulations = 0;
  f.state.hook = () => {
    if (f.state.simulations === 1) {
      f.state.slot = '101';
      f.state.recipientCredit = 99999n;
    }
  };
  const result = await f.run();
  expect(result).toMatchObject({
    sourceSlot: 101,
    slot: 101,
    simulationAttempts: 2,
    sourceBankMatched: true,
  });
  expect(result.accounting).toEqual(baseline.accounting);
});
it('stops after three bank rollovers without granting signing or sending', async () => {
  const f = await fixture();
  f.state.hook = () => {
    f.state.slot = String(BigInt(f.state.slot) + 1n);
  };
  await expect(f.run()).rejects.toThrow(
    'matching bank snapshot after three attempts',
  );
  expect(f.state.simulations).toBe(3);
  expect(f.calls.some((c) => /send|sign|bundle/i.test(c.method))).toBe(false);
});
it('allows later shared credits but still rejects a recipient authority change', async () => {
  const f = await fixture(),
    baseline = await f.run();
  // Changing balances within one reported bank would be inconsistent. Advance only after simulation for the stable read.
  f.state.sourceHook = () => {
    if (f.state.simulations >= 2) f.state.recipientCredit += 100n;
  };
  const result = await f.run();
  expect(result.accounting).toEqual(baseline.accounting);
  const key = f.packet.buyerAccounts[0].buybackAccount;
  (
    f.evidence.before[
      f.evidence.addresses.indexOf(key)
    ] as NonNullable<PumpRpcAccount>
  ).executable = true;
  await expect(f.run()).rejects.toThrow('shared fee recipient authority');
});

it('rejects stock recipient rent and authority drift, and an unrelated wallet debit after credits', async () => {
  for (const mutation of ['rent', 'delegate', 'existence']) {
    const f = await fixture(true),
      key = f.packet.buyerAccounts[0].buybackAccount;
    const i = f.evidence.addresses.indexOf(key);
    if (mutation === 'existence')
      f.evidence.before[i] = structuredClone(f.evidence.after[i]);
    else {
      const account = f.evidence.after[i] as NonNullable<PumpRpcAccount>;
      if (mutation === 'rent') account.lamports = '1000001';
      else {
        const bytes = Buffer.from(account.data[0], 'base64');
        bytes[72] = 1;
        account.data[0] = bytes.toString('base64');
      }
    }
    await expect(f.run()).rejects.toThrow();
  }
  const f = await fixture();
  f.state.recipientCredit = 9999999n;
  const i = f.evidence.addresses.indexOf(f.input.holders[0].address);
  const wallet = f.evidence.after[i] as NonNullable<PumpRpcAccount>;
  wallet.lamports = (BigInt(wallet.lamports) - 1n).toString();
  await expect(f.run()).rejects.toThrow();
});
it('rejects own-wallet drift on a rollover retry and respects cancellation between attempts', async () => {
  const f = await fixture();
  f.state.hook = () => {
    f.state.slot = '101';
    f.state.changed = true;
  };
  await expect(f.run()).rejects.toThrow('funding changed');
  expect(f.state.simulations).toBe(1);
  const g = await fixture(),
    controller = new AbortController();
  g.state.hook = () => {
    g.state.slot = '101';
    controller.abort();
  };
  await expect(
    simulatePumpHolderPacket(
      g.input,
      g.limits,
      g.funding,
      g.creation,
      controller.signal,
      g.rpc,
    ),
  ).rejects.toThrow();
  expect(g.state.simulations).toBe(1);
});

it('rejects inconsistent recipient credits within the same reported simulation bank', async () => {
  const f = await fixture();
  f.state.hook = () => {
    f.state.recipientCredit = 999999n;
  };
  await expect(f.run()).rejects.toThrow();
});
