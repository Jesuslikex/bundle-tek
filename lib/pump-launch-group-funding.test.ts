import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { raw, SYSTEM } from '../test/pump-launch-simulation-fixture';

import { pumpLaunchGroupFundingFixture as fixture } from '../test/pump-launch-group-funding-fixture';
for (const [stock, token22] of [
  [false, false],
  [true, false],
  [true, true],
])
  it(`checks every packet fee and wallet cap using batched coherent snapshots (${stock},${token22})`, async () => {
    const f = await fixture(stock, token22),
      result = await f.run();
    expect(result).toMatchObject({
      format: 'pump-launch-group-funding-v1',
      manifestSha256: f.group.manifestSha256,
      fundingValidated: true,
      settlementValidated: false,
      signingAllowed: false,
      executionAllowed: false,
      snapshotBankMatched: true,
      sourceBankSlots: { before: 100, after: 100 },
    });
    expect(result.wallets).toHaveLength(45);
    expect(result.networkFeeRaw).toBe(
      (
        BigInt(f.group.packets.length + 1 + f.group.activeHolderCount) * 5000n
      ).toString(),
    );
    expect(result.packetFees).toEqual(
      f.group.packets.map((p, index) => ({
        index,
        networkFeeRaw: (BigInt(p.requiredSigners.length) * 5000n).toString(),
      })),
    );
    const queries = f.calls.filter((c) => c.method === 'getMultipleAccounts');
    expect(queries.length).toBeGreaterThan(2);
    expect(queries.every((c) => (c.params[0] as string[]).length <= 100)).toBe(
      true,
    );
    const keys = [
      ...new Set(
        f.group.packets.flatMap((p) =>
          getCompiledTransactionMessageDecoder()
            .decode(
              getTransactionDecoder().decode(
                Buffer.from(p.transaction, 'base64'),
              ).messageBytes,
            )
            .staticAccounts.map(String),
        ),
      ),
    ];
    expect(result.accountHashes.map((a) => a.address)).toEqual(keys);
    expect(
      result.wallets
        .filter((w) => !w.active)
        .every((w) => w.requiredSolRaw === '0' && w.observedSolRaw === null),
    ).toBe(true);
    expect(
      f.calls.every((c) =>
        [
          'getGenesisHash',
          'getFeeForMessage',
          'getMultipleAccounts',
          'isBlockhashValid',
          'getBlockHeight',
        ].includes(c.method),
      ),
    ).toBe(true);
  });
it('funds the full 200-slot group without skipping later account batches', async () => {
  const f = await fixture(false, false, 200),
    result = await f.run();
  expect(result.wallets).toHaveLength(201);
  expect(result.packetFees).toHaveLength(f.group.packets.length);
  expect(result.accountHashes.length).toBeGreaterThan(500);
  const last = f.input.holders.at(-1)!;
  expect(result.wallets.at(-1)?.address).toBe(last.address);
}, 30000);
it('sums fees across packets instead of accepting an individually affordable fee', async () => {
  const f = await fixture();
  f.state.fee = '4000000';
  await expect(f.run()).rejects.toThrow('group network fees exceed');
  expect(
    f.calls.filter((c) => c.method === 'getMultipleAccounts'),
  ).toHaveLength(0);
});
it('requires the last wallet full SOL and stock quote budgets', async () => {
  for (const stock of [false, true]) {
    const f = await fixture(stock),
      last = f.input.holders.at(-1)!;
    if (!stock)
      f.accounts.set(last.address, raw(SYSTEM, new Uint8Array(), '10000000'));
    else {
      const buyer = f.group.packets
          .flatMap((p) => p.buyerAccounts)
          .find((b) => b.payer === last.address)!,
        account = f.accounts.get(buyer.userQuoteAccount)!,
        bytes = Buffer.from(account.data[0], 'base64');
      bytes.writeBigUInt64LE(0n, 64);
      account.data[0] = bytes.toString('base64');
    }
    await expect(f.run()).rejects.toThrow(last.address);
  }
});
it('retries complete mixed-bank snapshots and refuses persistent mismatches', async () => {
  const f = await fixture();
  f.state.slotFor = (number, requested) =>
    number === 2 ? requested + 1 : requested;
  const result = await f.run();
  expect(result.sourceBankSlots).toEqual({ before: 101, after: 101 });
  expect(f.state.snapshots).toBe(6);
  const bad = await fixture();
  bad.state.slotFor = (number, requested) => requested + (number % 2);
  await expect(bad.run()).rejects.toThrow('one reported bank');
  expect(bad.state.snapshots).toBe(6);
});
it('checks exact creation evidence, allowances and configuration without claiming settlement', async () => {
  const missing = await fixture();
  missing.evidence.accountHashes = [];
  await expect(missing.run()).rejects.toThrow('complete creation evidence');
  expect(missing.calls).toEqual([]);
  const limits = await fixture();
  limits.limits.holders.reverse();
  await expect(limits.run()).rejects.toThrow('every holder slot');
  expect(limits.calls).toEqual([]);
  const mismatch = await fixture();
  const account = mismatch.accounts.get(mismatch.input.create.global.address)!;
  account.executable = true;
  mismatch.evidence.accountHashes[0].beforeSha256 = createHash('sha256')
    .update(JSON.stringify(account))
    .digest('hex');
  await expect(mismatch.run()).rejects.toThrow('configuration differs');
});
it('rejects malformed account batches and late network or lifetime changes', async () => {
  const f = await fixture();
  await expect(
    f.run(undefined, async (method, params, signal) =>
      method === 'getMultipleAccounts'
        ? { context: { slot: '100' }, value: [] }
        : f.rpc(method, params, signal),
    ),
  ).rejects.toThrow('mapping differs');
  const expired = await fixture();
  expired.state.height = '995';
  await expect(expired.run()).rejects.toThrow('close to expiry');
  const changed = await fixture();
  let reads = 0;
  await expect(
    changed.run(undefined, async (method, params, signal) =>
      method === 'getGenesisHash' && ++reads === 2
        ? 'different-network'
        : changed.rpc(method, params, signal),
    ),
  ).rejects.toThrow('network changed');
});
it('rejects own-wallet changes while admitting only packet-derived shared balance credits', async () => {
  const f = await fixture(),
    key = f.group.packets[0].buyerAccounts[0].buybackAccount;
  f.state.hook = (number) => {
    if (number === 3) f.accounts.get(key)!.lamports = '7777777';
  };
  expect((await f.run()).fundingValidated).toBe(true);
  const changed = await fixture();
  changed.state.hook = (number) => {
    if (number === 3)
      changed.accounts.get(changed.input.holders.at(-1)!.address)!.lamports =
        '999999999';
  };
  await expect(changed.run()).rejects.toThrow('state changed during');
});
it('terminates on cancellation even when an injected read provider ignores abort', async () => {
  const f = await fixture();
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = f.run(controller.signal, async (method, params, signal) => {
    if (method === 'getFeeForMessage') {
      ready();
      return new Promise(() => {});
    }
    return f.rpc(method, params, signal);
  });
  await started;
  controller.abort(new Error('stop ignored provider'));
  await expect(pending).rejects.toThrow('stop ignored provider');
});
