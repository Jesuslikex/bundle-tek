import { expect, it } from 'vitest';
import { simulatePumpInitialBuy } from './pump-initial-buy-simulation';
import {
  pumpInitialBuySimulationFixture,
  initialBuyFeeFixture,
  initialBuyVolumeFixture,
} from '../test/pump-initial-buy-simulation-fixture';
import {
  decodePumpInitialBuyState,
  pumpInitialBuyPrice,
} from './pump-initial-buy-state';
import { pumpAccountBytes } from './pump-launch-simulation';
import { raw, SYSTEM } from '../test/pump-launch-simulation-fixture';
import { PUMP_TOKEN_2022 } from './pump-launch-config';
it('cancels a provider that ignores its abort signal and performs no broadcast', async () => {
  const f = await pumpInitialBuySimulationFixture(),
    controller = new AbortController();
  let notify!: () => void;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const pending = simulatePumpInitialBuy(
    f.intent,
    '10000000',
    controller.signal,
    async () => {
      notify();
      return new Promise(() => {});
    },
  );
  await entered;
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
it('uses the native, stable or exotic fee schedules exactly and rejects unsorted tiers', () => {
  const config = decodePumpInitialBuyState('FeeConfig', initialBuyFeeFixture());
  const input = {
    quoteMint: 'So11111111111111111111111111111111111111112',
    virtualTokensRaw: '1073000000000000',
    virtualQuoteRaw: '30000000000',
    tokenAmountRaw: '1000000000000',
    feeConfig: config,
  };
  config.fee_tiers = [
    {
      market_cap_lamports_threshold: 0n,
      fees: { lp_fee_bps: 0n, protocol_fee_bps: 95n, creator_fee_bps: 30n },
    },
    {
      market_cap_lamports_threshold: 27000000000n,
      fees: { lp_fee_bps: 0n, protocol_fee_bps: 200n, creator_fee_bps: 10n },
    },
    {
      market_cap_lamports_threshold: 30000000000n,
      fees: { lp_fee_bps: 0n, protocol_fee_bps: 100n, creator_fee_bps: 15n },
    },
  ];
  expect(pumpInitialBuyPrice(input)).toMatchObject({
    protocolFeeBps: '200',
    creatorFeeBps: '10',
  });
  config.stable_fee_tiers = [
    {
      market_cap_lamports_threshold: 0n,
      fees: { lp_fee_bps: 0n, protocol_fee_bps: 25n, creator_fee_bps: 5n },
    },
  ];
  expect(
    pumpInitialBuyPrice({
      ...input,
      quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    }),
  ).toMatchObject({ protocolFeeBps: '25', creatorFeeBps: '5' });
  config.exotic_flat_fees = {
    lp_fee_bps: 0n,
    protocol_fee_bps: 10n,
    creator_fee_bps: 90n,
  };
  expect(
    pumpInitialBuyPrice({
      ...input,
      quoteMint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
    }),
  ).toMatchObject({ protocolFeeBps: '10', creatorFeeBps: '90' });
  (config.fee_tiers as unknown[]).reverse();
  expect(() => pumpInitialBuyPrice(input)).toThrow('fee tiers differ');
});
it('rejects changed volume ownership, claim rewards and malformed simulation account maps', async () => {
  const owner = await pumpInitialBuySimulationFixture();
  owner.before.set(
    owner.packet.volumeAccount,
    raw(
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      initialBuyVolumeFixture(SYSTEM),
    ),
  );
  await expect(run(owner)).rejects.toThrow('another user');
  const reward = await pumpInitialBuySimulationFixture();
  reward.state.postHook = (post) => {
    const account = post.get(reward.packet.volumeAccount)!;
    const bytes = pumpAccountBytes(account);
    new DataView(bytes.buffer).setBigUint64(41, 1n, true);
    post.set(reward.packet.volumeAccount, raw(account.owner, bytes));
  };
  await expect(run(reward)).rejects.toThrow('unrelated volume rewards');
  const mapping = await pumpInitialBuySimulationFixture();
  let count = 0;
  await expect(
    simulatePumpInitialBuy(
      mapping.intent,
      '10000000',
      new AbortController().signal,
      async (method, params, signal) => {
        const response = await mapping.rpc(method, params, signal);
        if (method === 'simulateTransaction' && ++count === 2)
          (response as { value: { accounts: unknown[] } }).value.accounts.pop();
        return response;
      },
    ),
  ).rejects.toThrow('account mapping differs');
});
const run = (f: Awaited<ReturnType<typeof pumpInitialBuySimulationFixture>>) =>
  simulatePumpInitialBuy(
    f.intent,
    '10000000',
    new AbortController().signal,
    f.rpc,
  );
for (const [stock, token22] of [
  [false, false],
  [true, false],
  [true, true],
])
  it(`independently reconciles atomic settlement (${stock ? (token22 ? 'Token-2022 stock' : 'SPL stock') : 'SOL'})`, async () => {
    const f = await pumpInitialBuySimulationFixture(stock, token22),
      report = await run(f);
    expect(report.preparation.containsInitialBuy).toBe(true);
    expect(report.preparation.transactionVersion).toBe(1);
    expect(report.simulation.status).toBe('Simulated');
    expect(report.signingAllowed).toBe(false);
    expect(report.executionAllowed).toBe(false);
    expect(report.simulation.feeAndRentDebitRaw).toBe(
      stock ? '7010000' : '5010000',
    );
    expect(report.simulation.quoteCostRaw).toBe(
      report.simulation.price.totalQuoteCostRaw,
    );
    expect(
      BigInt(report.simulation.buybackFeeRaw) +
        BigInt(report.simulation.retainedProtocolFeeRaw),
    ).toBe(BigInt(report.simulation.price.protocolFeeRaw));
    expect(report.simulation.creatorFeeUnclaimedRaw).toBe(
      report.simulation.price.creatorFeeRaw,
    );
    expect(report.simulation.reads).toBeLessThanOrEqual(48);
    expect(report.simulation.buybackSplitRoundingAttested).toBe(false);
    const requests = f.calls.filter(
      (call) => call.method === 'simulateTransaction',
    );
    expect(requests).toHaveLength(2);
    expect(requests[1].params[0]).toBe(report.preparation.transaction);
    expect(requests[1].params[1]).toMatchObject({
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: 100,
    });
    expect(
      f.calls.some((call) =>
        ['sendTransaction', 'sendBundle'].includes(call.method),
      ),
    ).toBe(false);
  });
it('requires the full gross native and quote-token caps, not only the observed simulated spend', async () => {
  const native = await pumpInitialBuySimulationFixture();
  native.intent.maximumQuoteCostRaw = '1000000000';
  await expect(run(native)).rejects.toThrow('full quote plus fee/rent');
  const stock = await pumpInitialBuySimulationFixture(true);
  stock.intent.maximumQuoteCostRaw = '200000001';
  await expect(run(stock)).rejects.toThrow('full reviewed quote-token');
  const cap = await pumpInitialBuySimulationFixture();
  cap.intent.maximumQuoteCostRaw = '1';
  await expect(run(cap)).rejects.toThrow('price and fees exceed');
});
it('rejects wrong output, quote diversion and changed mint authority even with successful RPC status', async () => {
  const missing = await pumpInitialBuySimulationFixture();
  missing.state.postHook = (post) => {
    post.set(
      missing.packet.userBaseAccount,
      raw(
        PUMP_TOKEN_2022,
        missing.token(missing.f.mint, missing.f.payer, 999999999999n, true),
      ),
    );
  };
  await expect(run(missing)).rejects.toThrow(
    'custody identity, amount or authority',
  );
  const quote = await pumpInitialBuySimulationFixture(true);
  quote.state.postHook = (post) => {
    const account = post.get(quote.packet.userQuoteAccount)!;
    const bytes = pumpAccountBytes(account);
    new DataView(bytes.buffer).setBigUint64(64, 1n, true);
    post.set(quote.packet.userQuoteAccount, raw(account.owner, bytes));
  };
  await expect(run(quote)).rejects.toThrow(
    'custody identity, amount or authority',
  );
  const mint = await pumpInitialBuySimulationFixture();
  mint.state.postHook = (post) => {
    const account = post.get(mint.f.mint)!;
    const bytes = pumpAccountBytes(account);
    new DataView(bytes.buffer).setUint32(0, 1, true);
    post.set(mint.f.mint, raw(account.owner, bytes));
  };
  await expect(run(mint)).rejects.toThrow('validated mint');
});
it('rejects fee/config changes, payer authority changes and unexplained SOL credits', async () => {
  const config = await pumpInitialBuySimulationFixture();
  config.state.postHook = (post) => {
    const account = post.get(config.packet.feeConfig)!;
    post.set(config.packet.feeConfig, { ...account, lamports: '1' });
  };
  await expect(run(config)).rejects.toThrow('readonly or executable');
  const payer = await pumpInitialBuySimulationFixture();
  payer.state.postHook = (post) => {
    const account = post.get(payer.f.payer)!;
    post.set(payer.f.payer, { ...account, owner: PUMP_TOKEN_2022 });
  };
  await expect(run(payer)).rejects.toThrow('payer authority');
  const extra = await pumpInitialBuySimulationFixture();
  extra.state.postHook = (post) => {
    const account = post.get(extra.f.payer)!;
    post.set(extra.f.payer, {
      ...account,
      lamports: (BigInt(account.lamports) - 1n).toString(),
    });
  };
  await expect(run(extra)).rejects.toThrow('do not reconcile');
});
it('rechecks fee-account source state and original deployment metadata after simulation', async () => {
  const stale = await pumpInitialBuySimulationFixture();
  stale.state.postHook = () => {
    stale.before.set(stale.packet.feeConfig, raw(SYSTEM));
  };
  await expect(run(stale)).rejects.toThrow('source state changed');
  const program = await pumpInitialBuySimulationFixture(false, false, true);
  // Change the independently re-read deployment metadata after atomic simulation.
  let read = 0;
  const rpc = async (
    method: string,
    params: unknown[],
    signal: AbortSignal,
  ) => {
    const result = (await program.rpc(method, params, signal)) as {
      value?: Array<{ data: [string, string] }>;
    };
    if (
      method === 'getMultipleAccounts' &&
      (params[1] as { dataSlice?: unknown }).dataSlice &&
      ++read === 4 &&
      result.value
    ) {
      const bytes = Uint8Array.from(atob(result.value[0].data[0]), (char) =>
        char.charCodeAt(0),
      );
      bytes[4] ^= 1;
      result.value[0].data[0] = btoa(String.fromCharCode(...bytes));
    }
    return result;
  };
  await expect(
    simulatePumpInitialBuy(
      program.intent,
      '10000000',
      new AbortController().signal,
      rpc,
    ),
  ).rejects.toThrow('program changed');
});
it('rejects replacement lifetimes, failed simulation, malformed mappings and resource overflow', async () => {
  for (const change of [
    { err: 'InsufficientFunds' },
    { replacement: { blockhash: 'different' } },
    { units: '1400001' },
    { loadedBytes: '67108865' },
    { fee: '10001' },
  ]) {
    const f = await pumpInitialBuySimulationFixture();
    Object.assign(f.state, change);
    await expect(run(f)).rejects.toThrow();
  }
});
it('pins fee layout and exact rounding, and rejects malformed/unknown state fields', () => {
  const config = decodePumpInitialBuyState('FeeConfig', initialBuyFeeFixture());
  const price = pumpInitialBuyPrice({
    quoteMint: 'So11111111111111111111111111111111111111112',
    virtualTokensRaw: '1073000000000000',
    virtualQuoteRaw: '30000000000',
    tokenAmountRaw: '1000000000000',
    feeConfig: config,
  });
  expect(price).toMatchObject({
    principalRaw: '27985075',
    protocolFeeRaw: '265859',
    creatorFeeRaw: '83956',
    totalQuoteCostRaw: '28334890',
  });
  const bad = initialBuyFeeFixture();
  bad[0] ^= 1;
  expect(() => decodePumpInitialBuyState('FeeConfig', bad)).toThrow(
    'discriminator',
  );
  expect(() =>
    decodePumpInitialBuyState('FeeConfig', initialBuyFeeFixture().slice(0, 70)),
  ).toThrow('Truncated');
  const tail = new Uint8Array(initialBuyFeeFixture().length + 1);
  tail.set(initialBuyFeeFixture());
  tail[tail.length - 1] = 1;
  expect(() => decodePumpInitialBuyState('FeeConfig', tail)).toThrow(
    'unknown fields',
  );
  const volume = initialBuyVolumeFixture('11111111111111111111111111111111');
  volume[40] = 2;
  expect(() =>
    decodePumpInitialBuyState('UserVolumeAccumulator', volume),
  ).toThrow('boolean');
});

it('derives the saved percentage from independently observed supply and rejects mixed target inputs', async () => {
  const f = await pumpInitialBuySimulationFixture();
  const { tokenAmountRaw: _target, ...intent } = f.intent;
  const report = await simulatePumpInitialBuy(
    { ...intent, developerSupplyPercent: 0.1 },
    '10000000',
    new AbortController().signal,
    f.rpc,
  );
  expect(report.simulation.tokenAmountRaw).toBe('1000000000000');
  expect(
    f.calls.filter((c) => c.method === 'simulateTransaction'),
  ).toHaveLength(2);
  const untouched = await pumpInitialBuySimulationFixture();
  await expect(
    simulatePumpInitialBuy(
      { ...untouched.intent, developerSupplyPercent: 0.1 },
      '10000000',
      new AbortController().signal,
      untouched.rpc,
    ),
  ).rejects.toThrow('Unsupported');
  expect(untouched.calls).toEqual([]);
});
