import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { generateKeyPairSigner } from '@solana/kit';
import {
  buildPumpCreateHolderMessage,
  type PumpHolderBuy,
} from './pump-holder-message';
import { collectPumpHolderFunding } from './pump-holder-funding';
import {
  pumpCreateFixture,
  pumpFixtureQuoteAccount,
} from '../test/pump-launch-fixtures';
import { raw, SYSTEM } from '../test/pump-launch-simulation-fixture';
import { PUMP_TOKEN, PUMP_TOKEN_2022 } from './pump-launch-config';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc, PumpRpcAccount } from './pump-launch-simulation';

async function fixture(stock = false, token22 = false) {
  const create = await pumpCreateFixture(stock);
  if (stock && token22)
    create.quoteMintAccount = pumpFixtureQuoteAccount(
      undefined,
      PUMP_TOKEN_2022,
    );
  const holders: PumpHolderBuy[] = [
    {
      address: (await generateKeyPairSigner()).address,
      kind: 'exact-base-output',
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '100000000',
    },
    {
      address: (await generateKeyPairSigner()).address,
      kind: 'exact-quote-input',
      quoteAmountRaw: '1000000',
      minimumTokenOutputRaw: '1000000',
    },
    { address: (await generateKeyPairSigner()).address, kind: 'none' },
  ];
  const input = {
      create,
      holders,
      developer: {
        tokenAmountRaw: '1000000000000',
        maximumQuoteCostRaw: '100000000',
      },
    },
    packet = await buildPumpCreateHolderMessage(input);
  const limits = {
    deployerFeeAndRentLimitRaw: '10000000',
    developerMaximumQuoteCostRaw: '100000000',
    holders: holders.map((h) => ({
      address: h.address,
      feeAndRentLimitRaw: h.kind === 'none' ? '0' : '10000000',
      maximumQuoteCostRaw:
        h.kind === 'exact-base-output' ? h.maximumQuoteCostRaw : null,
      minimumTokenOutputRaw:
        h.kind === 'exact-quote-input' ? h.minimumTokenOutputRaw : null,
    })),
  };
  const accounts = new Map<string, PumpRpcAccount>();
  for (const key of [
    create.payer,
    ...holders.filter((h) => h.kind !== 'none').map((h) => h.address),
  ])
    accounts.set(key, raw(SYSTEM, new Uint8Array(), '1000000000'));
  accounts.set(
    create.global.address,
    raw(create.global.owner, create.global.data),
  );
  const mint = create.quoteMintAccount;
  const nativeMint = new Uint8Array(82);
  nativeMint[44] = 9;
  nativeMint[45] = 1;
  accounts.set(
    create.quoteMint,
    mint ? raw(mint.owner, mint.data) : raw(PUMP_TOKEN, nativeMint),
  );
  if (stock)
    for (const buyer of packet.buyerAccounts) {
      const b = new Uint8Array(165);
      b.set(bs58.decode(create.quoteMint));
      b.set(bs58.decode(buyer.payer), 32);
      new DataView(b.buffer).setBigUint64(64, 1000000000n, true);
      b[108] = 1;
      accounts.set(buyer.userQuoteAccount, raw(packet.quote.tokenProgram, b));
    }
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
  const calls: { method: string; params: unknown[] }[] = [];
  const state = {
    slot: '100',
    genesis: SOLANA_MAINNET_GENESIS,
    fee: '20000',
    height: '900',
    valid: true,
    snapshot: 0,
    hook: (_number: number) => {},
  };
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    signal.throwIfAborted();
    calls.push({ method, params });
    const context = { slot: state.slot };
    if (method === 'getGenesisHash') return state.genesis;
    if (method === 'getFeeForMessage') return { context, value: state.fee };
    if (method === 'getBlockHeight') return state.height;
    if (method === 'isBlockhashValid') return { context, value: state.valid };
    if (method === 'getMultipleAccounts') {
      state.hook(++state.snapshot);
      return {
        context,
        value: (params[0] as string[]).map((k) =>
          structuredClone(accounts.get(k) ?? null),
        ),
      };
    }
    throw new Error('Unexpected RPC method: ' + method);
  };
  const run = (signal = new AbortController().signal) =>
    collectPumpHolderFunding(input, limits, evidence, signal, rpc);
  return { input, limits, evidence, packet, accounts, state, calls, rpc, run };
}
for (const [stock, token22] of [
  [false, false],
  [true, false],
  [true, true],
])
  it(`observes every wallet full cap without simulating, signing or sending (${stock}, token22=${token22})`, async () => {
    const f = await fixture(stock, token22),
      result = await f.run();
    expect(result).toMatchObject({
      fundingValidated: true,
      settlementValidated: false,
      simulationRequired: true,
      signingAllowed: false,
      executionAllowed: false,
      completeLaunch: false,
      packetSha256: f.packet.packetSha256,
      networkFeeRaw: '20000',
    });
    expect(result.wallets).toHaveLength(4);
    expect(result.wallets[1].requiredSolRaw).toBe(
      stock ? '10000000' : '110000000',
    );
    expect(result.wallets[2].quoteLimitRaw).toBe('1000000');
    expect(result.wallets[3]).toMatchObject({
      active: false,
      observedSolRaw: null,
    });
    expect(f.calls.map((c) => c.method)).toEqual([
      'getGenesisHash',
      'getFeeForMessage',
      'getMultipleAccounts',
      'getMultipleAccounts',
      'isBlockhashValid',
      'getBlockHeight',
      'getGenesisHash',
    ]);
    expect(result.accountHashes.length).toBe(f.packet.accountCount);
  });
it('requires exact holder order, allowances and denomination before RPC', async () => {
  const f = await fixture();
  [f.limits.holders[0], f.limits.holders[1]] = [
    f.limits.holders[1],
    f.limits.holders[0],
  ];
  await expect(f.run()).rejects.toThrow('every holder slot');
  expect(f.calls).toEqual([]);
});
it('requires the full SOL cap plus rent allowance for each holder, including the last active slot', async () => {
  const f = await fixture();
  f.accounts.set(
    f.input.holders[1].address,
    raw(SYSTEM, new Uint8Array(), '10999999'),
  );
  await expect(f.run()).rejects.toThrow('full SOL');
});
it('checks native account ownership instead of trusting its balance', async () => {
  const f = await fixture();
  f.accounts.get(f.input.holders[0].address)!.owner = PUMP_TOKEN;
  await expect(f.run()).rejects.toThrow('full SOL');
});
it('requires full stock-token caps even when the wallet has ample SOL', async () => {
  const f = await fixture(true),
    buyer = f.packet.buyerAccounts[2],
    a = f.accounts.get(buyer.userQuoteAccount)!;
  const data = Buffer.from(a.data[0], 'base64');
  data.writeBigUInt64LE(999999n, 64);
  a.data[0] = data.toString('base64');
  await expect(f.run()).rejects.toThrow('full quote-token allowance');
});
it('rejects delegated, frozen and wrong-owner stock-token sources', async () => {
  for (const [offset, value] of [
    [72, 1],
    [108, 2],
    [32, 7],
  ]) {
    const f = await fixture(true, true),
      buyer = f.packet.buyerAccounts[1],
      a = f.accounts.get(buyer.userQuoteAccount)!;
    const data = Buffer.from(a.data[0], 'base64');
    data[offset] = offset === 32 ? data[offset] ^ 255 : value;
    a.data[0] = data.toString('base64');
    await expect(f.run()).rejects.toThrow('custody');
  }
});
it('rejects pre-existing destination custody and mid-read account changes', async () => {
  const f = await fixture();
  f.accounts.set(f.packet.buyerAccounts[1].userBaseAccount, raw(SYSTEM));
  await expect(f.run()).rejects.toThrow('destination token account');
  f.accounts.delete(f.packet.buyerAccounts[1].userBaseAccount);
  f.state.hook = (n) => {
    if (n === 3)
      f.accounts.get(f.input.holders[1].address)!.lamports = '999999999';
  };
  await expect(f.run()).rejects.toThrow('state changed during');
});
it('rejects a moved creation snapshot, expired lifetime, wrong network and excessive fees', async () => {
  const f = await fixture();
  f.evidence.accountHashes[0].beforeSha256 = '0'.repeat(64);
  await expect(f.run()).rejects.toThrow('Creation state changed');
  for (const mutation of [
    { valid: false },
    { height: '990' },
    { genesis: 'wrong' },
    { fee: '10000001' },
    { slot: '99' },
  ]) {
    const next = await fixture();
    Object.assign(next.state, mutation);
    await expect(next.run()).rejects.toThrow();
  }
});
it('does not make provider calls after cancellation', async () => {
  const f = await fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(f.run(controller.signal)).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
