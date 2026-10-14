import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { generateKeyPairSigner } from '@solana/kit';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { buildPumpLaunchPacketGroup } from './pump-launch-packet-group';
import { collectPumpLaunchGroupFunding } from './pump-holder-funding';
import {
  pumpCreateFixture,
  pumpFixtureQuoteAccount,
} from '../test/pump-launch-fixtures';
import { raw, SYSTEM } from '../test/pump-launch-simulation-fixture';
import { PUMP_TOKEN, PUMP_TOKEN_2022 } from './pump-launch-config';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpHolderMessageInput } from './pump-holder-message';
import type { PumpLaunchRpc, PumpRpcAccount } from './pump-launch-simulation';

async function fixture(stock = false, token22 = false, count = 44) {
  const create = await pumpCreateFixture(stock);
  if (token22)
    create.quoteMintAccount = pumpFixtureQuoteAccount(
      undefined,
      PUMP_TOKEN_2022,
    );
  const input: PumpHolderMessageInput = {
    create,
    developer: {
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '100000000',
    },
    holders: (
      await Promise.all(
        Array.from({ length: count }, () => generateKeyPairSigner()),
      )
    ).map((wallet, i) =>
      i % 7 === 6
        ? { address: wallet.address, kind: 'none' }
        : i % 2 === 0
          ? {
              address: wallet.address,
              kind: 'exact-base-output',
              tokenAmountRaw: '1000000',
              maximumQuoteCostRaw: '100000000',
            }
          : {
              address: wallet.address,
              kind: 'exact-quote-input',
              quoteAmountRaw: '1000000',
              minimumTokenOutputRaw: '1000000',
            },
    ),
  };
  const group = await buildPumpLaunchPacketGroup(input),
    accounts = new Map<string, PumpRpcAccount>();
  for (const key of [
    create.payer,
    ...input.holders.filter((h) => h.kind !== 'none').map((h) => h.address),
  ])
    accounts.set(key, raw(SYSTEM, new Uint8Array(), '1000000000'));
  accounts.set(
    create.global.address,
    raw(create.global.owner, create.global.data),
  );
  const nativeMint = new Uint8Array(82);
  nativeMint[44] = 9;
  nativeMint[45] = 1;
  accounts.set(
    create.quoteMint,
    create.quoteMintAccount
      ? raw(create.quoteMintAccount.owner, create.quoteMintAccount.data)
      : raw(PUMP_TOKEN, nativeMint),
  );
  const buyers = group.packets.flatMap((p) => p.buyerAccounts);
  for (const buyer of buyers) {
    if (stock) {
      const data = new Uint8Array(165);
      data.set(bs58.decode(create.quoteMint));
      data.set(bs58.decode(buyer.payer), 32);
      new DataView(data.buffer).setBigUint64(64, 1000000000n, true);
      data[108] = 1;
      accounts.set(buyer.userQuoteAccount, raw(group.quote.tokenProgram, data));
    } else
      accounts.set(
        buyer.buybackAccount,
        raw(SYSTEM, new Uint8Array(), '1000000'),
      );
  }
  const limits = {
    deployerFeeAndRentLimitRaw: '10000000',
    developerMaximumQuoteCostRaw: '100000000',
    holders: input.holders.map((h) => ({
      address: h.address,
      feeAndRentLimitRaw: h.kind === 'none' ? '0' : '10000000',
      maximumQuoteCostRaw:
        h.kind === 'exact-base-output' ? h.maximumQuoteCostRaw : null,
      minimumTokenOutputRaw:
        h.kind === 'exact-quote-input' ? h.minimumTokenOutputRaw : null,
    })),
  };
  const evidence = {
    minimumSlot: 100,
    maximumSlot: 100,
    accountHashes: [create.global.address, create.payer, create.mint].map(
      (address) => ({
        address,
        beforeSha256: createHash('sha256')
          .update(JSON.stringify(accounts.get(address) ?? null))
          .digest('hex'),
      }),
    ),
  };
  const state = {
    snapshots: 0,
    fee: null as string | null,
    height: '900',
    valid: true,
    genesis: SOLANA_MAINNET_GENESIS,
    slotFor: (_number: number, requested: number) => requested,
    hook: (_number: number) => {},
  };
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    signal.throwIfAborted();
    calls.push({ method, params });
    if (method === 'getGenesisHash') return state.genesis;
    if (method === 'getFeeForMessage') {
      const message = getCompiledTransactionMessageDecoder().decode(
        Buffer.from(params[0] as string, 'base64'),
      );
      return {
        context: { slot: '100' },
        value:
          state.fee ??
          (BigInt(message.header.numSignerAccounts) * 5000n).toString(),
      };
    }
    if (method === 'getBlockHeight') return state.height;
    if (method === 'isBlockhashValid')
      return {
        context: {
          slot: String(
            Math.max(
              100,
              ...calls
                .filter((c) => c.method === 'getMultipleAccounts')
                .map(
                  (c) =>
                    (c.params[1] as { minContextSlot: number }).minContextSlot,
                ),
            ),
          ),
        },
        value: state.valid,
      };
    if (method === 'getMultipleAccounts') {
      const number = ++state.snapshots,
        requested = (params[1] as { minContextSlot: number }).minContextSlot;
      state.hook(number);
      return {
        context: { slot: String(state.slotFor(number, requested)) },
        value: (params[0] as string[]).map((key) =>
          structuredClone(accounts.get(key) ?? null),
        ),
      };
    }
    throw new Error('Unexpected method ' + method);
  };
  const run = (
    signal = new AbortController().signal,
    provider: PumpLaunchRpc = rpc,
  ) => collectPumpLaunchGroupFunding(input, limits, evidence, signal, provider);
  return { input, group, accounts, limits, evidence, state, calls, rpc, run };
}
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
