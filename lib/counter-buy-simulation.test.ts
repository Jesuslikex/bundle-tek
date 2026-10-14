import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { counterPreparationFixture } from '../test/counter-preparation-fixture';
import { routeWallet } from '../test/jupiter-route-fixture';
import { prepareCounterBuyProposal } from './counter-buy-preparation';
import {
  simulateCounterBuyPreparation,
  type CounterSimulationRpc,
} from './counter-buy-simulation';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { WRAPPED_SOL } from './warmup-swap-quote';
import {
  address,
  getBase64Decoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  SYSTEM = '11111111111111111111111111111111';
function raw(
  owner: string,
  data: Uint8Array,
  lamports = '2039280',
  executable = false,
) {
  return {
    owner,
    executable,
    lamports,
    data: [btoa(String.fromCharCode(...data)), 'base64'],
  };
}
function mint(decimals: number) {
  const b = new Uint8Array(82);
  b[44] = decimals;
  b[45] = 1;
  return raw(TOKEN, b);
}
function token(mint: string, amount: string) {
  const b = new Uint8Array(165),
    v = new DataView(b.buffer);
  b.set(bs58.decode(mint));
  b.set(bs58.decode(routeWallet), 32);
  v.setBigUint64(64, BigInt(amount), true);
  b[108] = 1;
  if (mint === WRAPPED_SOL) {
    v.setUint32(109, 1, true);
    v.setBigUint64(113, 2039280n, true);
  }
  return raw(TOKEN, b);
}
async function fixture() {
  const f = counterPreparationFixture();
  let n = 0;
  const order = await prepareCounterBuyProposal(
    f.plan,
    f.identity,
    '1005',
    routeWallet,
    'key',
    new AbortController().signal,
    async () => Response.json(++n === 1 ? f.quote : f.swap),
  );
  const keys = f.message.staticAccounts.map(String),
    before = [
      raw(SYSTEM, new Uint8Array(), '100000000'),
      token(WRAPPED_SOL, '0'),
      token(order.quote.outputMint, '0'),
      mint(9),
      mint(order.tokenDecimals),
      raw(
        'BPFLoaderUpgradeab1e11111111111111111111111',
        new Uint8Array(),
        '1',
        true,
      ),
      raw(
        'BPFLoaderUpgradeab1e11111111111111111111111',
        new Uint8Array(),
        '1',
        true,
      ),
    ];
  const after = structuredClone(before);
  after[0].lamports = '99994000';
  after[2] = token(order.quote.outputMint, order.quote.outputTargetRaw);
  const accounts = new Map(keys.map((key, i) => [key, before[i]]));
  let simulated = false;
  const base: CounterSimulationRpc = async (method, params) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getBlockHeight') return '1000';
    if (method === 'getFeeForMessage')
      return { context: { slot: '100' }, value: '5000' };
    if (method === 'getMultipleAccounts')
      return {
        context: { slot: simulated ? '101' : '100' },
        value: (params[0] as string[]).map((k) => accounts.get(k) ?? null),
      };
    if (method === 'simulateTransaction') {
      simulated = true;
      return {
        context: { slot: '101' },
        value: {
          err: null,
          accounts: after,
          unitsConsumed: '10000',
          fee: '5000',
          logs: ['PRIVATE-LOG'],
          returnData: 'PRIVATE-RETURN',
        },
      };
    }
    throw new Error('Unexpected RPC method.');
  };
  return { order, base, keys, before, after, accounts };
}
it('collects standard account snapshots and simulates the original packet without enriched balances or broadcast', async () => {
  const f = await fixture(),
    rpc = vi.fn(f.base),
    before = structuredClone(f.order);
  const result = await simulateCounterBuyPreparation(
    f.order,
    '5000',
    new AbortController().signal,
    rpc,
  );
  expect(result).toMatchObject({
    executionAllowed: false,
    instructionsVerified: false,
    originalBlockhashRetained: true,
    balanceAssessment: {
      status: 'Matched balances',
      checks: { exactOutput: true, netWalletDebitWithinLimit: true },
    },
  });
  const simulation = rpc.mock.calls.find(
    (c) => c[0] === 'simulateTransaction',
  )!;
  expect(simulation[1]).toEqual([
    f.order.preparation.transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: 100,
      accounts: { encoding: 'base64', addresses: f.keys },
      innerInstructions: false,
    },
  ]);
  expect(
    rpc.mock.calls.every((c) =>
      [
        'getGenesisHash',
        'getBlockHeight',
        'getFeeForMessage',
        'getMultipleAccounts',
        'simulateTransaction',
      ].includes(c[0]),
    ),
  ).toBe(true);
  expect(
    result.accountSnapshotHashes.every((a) => /^[a-f0-9]{64}$/.test(a.sha256)),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(f.order).toEqual(before);
});
it('rejects wrong networks, expired original blockhashes, unavailable fees and excessive fees before simulation', async () => {
  for (const [method, replacement] of [
    ['getGenesisHash', 'wrong'],
    ['getBlockHeight', '123457'],
    ['getFeeForMessage', { context: { slot: '100' }, value: null }],
    ['getFeeForMessage', { context: { slot: '100' }, value: '5001' }],
  ] as const) {
    const f = await fixture(),
      rpc = vi.fn(async (m: string, p: unknown[], s: AbortSignal) =>
        m === method ? replacement : f.base(m, p, s),
      );
    await expect(
      simulateCounterBuyPreparation(
        f.order,
        '5000',
        new AbortController().signal,
        rpc,
      ),
    ).rejects.toThrow();
    expect(rpc.mock.calls.some((c) => c[0] === 'simulateTransaction')).toBe(
      false,
    );
  }
});
it('rejects missing post accounts, replacement blockhashes, changed fees and stale simulation slots', async () => {
  for (const patch of [
    { accounts: undefined },
    { replacementBlockhash: { blockhash: 'PRIVATE' } },
    { fee: '5001' },
  ]) {
    const f = await fixture();
    await expect(
      simulateCounterBuyPreparation(
        f.order,
        '5000',
        new AbortController().signal,
        async (m, p, s) => {
          const value = await f.base(m, p, s);
          if (m !== 'simulateTransaction') return value;
          const result = value as { context: unknown; value: object };
          return { ...result, value: { ...result.value, ...patch } };
        },
      ),
    ).rejects.toThrow();
  }
  const f = await fixture();
  await expect(
    simulateCounterBuyPreparation(
      f.order,
      '5000',
      new AbortController().signal,
      async (m, p, s) =>
        m === 'simulateTransaction'
          ? {
              context: { slot: '99' },
              value: { err: null, accounts: f.after, unitsConsumed: '10000' },
            }
          : f.base(m, p, s),
    ),
  ).rejects.toThrow();
});
it('detects a wallet changing on the chain during simulation', async () => {
  const f = await fixture();
  let simulated = false;
  await expect(
    simulateCounterBuyPreparation(
      f.order,
      '5000',
      new AbortController().signal,
      async (m, p, s) => {
        const result = await f.base(m, p, s);
        if (m === 'simulateTransaction') {
          simulated = true;
          f.before[0].lamports = '99999999';
        }
        if (simulated && m === 'getMultipleAccounts')
          return {
            context: { slot: '101' },
            value: (p[0] as string[]).map((k) => f.accounts.get(k) ?? null),
          };
        return result;
      },
    ),
  ).rejects.toThrow('changed during simulation');
});
it('rejects changed precision, Token-2022, wrong ownership, frozen or delegated accounts and insufficient funds', async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.before[4] = mint(f.order.tokenDecimals + 1);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.before[2].owner = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      const b = Uint8Array.from(atob(f.before[2].data[0]), (c) =>
        c.charCodeAt(0),
      );
      b.set(bs58.decode(SYSTEM), 32);
      f.before[2] = raw(TOKEN, b);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      const b = Uint8Array.from(atob(f.before[2].data[0]), (c) =>
        c.charCodeAt(0),
      );
      b[108] = 2;
      f.before[2] = raw(TOKEN, b);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      const b = Uint8Array.from(atob(f.before[2].data[0]), (c) =>
        c.charCodeAt(0),
      );
      new DataView(b.buffer).setUint32(72, 1, true);
      f.before[2] = raw(TOKEN, b);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.before[0].lamports = '6004';
    },
  ]) {
    const f = await fixture();
    mutate(f);
    f.keys.forEach((k, i) => f.accounts.set(k, f.before[i]));
    await expect(
      simulateCounterBuyPreparation(
        f.order,
        '5000',
        new AbortController().signal,
        f.base,
      ),
    ).rejects.toThrow();
  }
});
it('records failed simulations as failed balance comparisons without upstream logs', async () => {
  const f = await fixture();
  const result = await simulateCounterBuyPreparation(
    f.order,
    '5000',
    new AbortController().signal,
    async (m, p, s) =>
      m === 'simulateTransaction'
        ? (await f.base(m, p, s),
          {
            context: { slot: '101' },
            value: {
              err: 'PRIVATE-FAILURE',
              unitsConsumed: '0',
              logs: ['PRIVATE-LOG'],
            },
          })
        : f.base(m, p, s),
  );
  expect(result.balanceAssessment).toMatchObject({
    status: 'Mismatch',
    checks: { simulationSucceeded: false },
    tokenChanges: [],
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('sanitizes RPC failures and aborts a provider that ignores cancellation', async () => {
  const f = await fixture();
  await expect(
    simulateCounterBuyPreparation(
      f.order,
      '5000',
      new AbortController().signal,
      async () => {
        throw new Error('PRIVATE-RPC');
      },
    ),
  ).rejects.toMatchObject({ message: expect.not.stringContaining('PRIVATE') });
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = simulateCounterBuyPreparation(
    f.order,
    '5000',
    controller.signal,
    () => {
      started();
      return new Promise(() => {});
    },
  );
  await ready;
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
});

it('rejects simulated wallet reassignment and mint mutation even when balance deltas appear safe', async () => {
  for (const index of [0, 4]) {
    const f = await fixture();
    if (index === 0) f.after[0].owner = TOKEN;
    else f.after[4] = mint(f.order.tokenDecimals + 1);
    await expect(
      simulateCounterBuyPreparation(
        f.order,
        '5000',
        new AbortController().signal,
        f.base,
      ),
    ).rejects.toThrow(/wallet authority changed|changed a mint/);
  }
});

it('collects more than 100 lookup-backed accounts in bounded batches and detects changed lookup contents', async () => {
  const f = await fixture(),
    p = counterPreparationFixture();
  if (p.message.version !== 0) throw new Error('Invalid fixture.');
  const tableAddress = bs58.encode(new Uint8Array(32).fill(200));
  const loaded = Array.from({ length: 100 }, (_, i) => {
    const bytes = new Uint8Array(32).fill(130);
    bytes[0] = i + 20;
    return bs58.encode(bytes);
  });
  p.message.addressTableLookups = [
    {
      lookupTableAddress: address(tableAddress),
      writableIndexes: [],
      readonlyIndexes: loaded.map((_, i) => i),
    },
  ];
  p.swap.swapTransaction = getBase64Decoder().decode(
    Uint8Array.from([
      1,
      ...new Uint8Array(64),
      ...getCompiledTransactionMessageEncoder().encode(p.message),
    ]),
  );
  const table = new Uint8Array(56 + loaded.length * 32),
    view = new DataView(table.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, (1n << 64n) - 1n, true);
  view.setBigUint64(12, 90n, true);
  loaded.forEach((key, i) => table.set(bs58.decode(key), 56 + i * 32));
  const tableAccount = raw(
    'AddressLookupTab1e1111111111111111111111111',
    table,
    '1',
  );
  let preparedCalls = 0;
  const order = await prepareCounterBuyProposal(
    p.plan,
    p.identity,
    '1005',
    routeWallet,
    'key',
    new AbortController().signal,
    async () => Response.json(++preparedCalls === 1 ? p.quote : p.swap),
    async (method) =>
      method === 'getGenesisHash'
        ? SOLANA_MAINNET_GENESIS
        : { context: { slot: '100' }, value: [tableAccount] },
  );
  const keys = [...f.keys, ...loaded],
    accounts = new Map(f.accounts);
  loaded.forEach((key) =>
    accounts.set(key, raw(SYSTEM, new Uint8Array(), '0')),
  );
  let simulated = false;
  const rpc = vi.fn(
    async (method: string, params: unknown[], signal: AbortSignal) => {
      if (method === 'getMultipleAccounts')
        return {
          context: { slot: simulated ? '101' : '100' },
          value: (params[0] as string[]).map((key) =>
            key === tableAddress ? tableAccount : (accounts.get(key) ?? null),
          ),
        };
      if (method === 'simulateTransaction') {
        simulated = true;
        return {
          context: { slot: '101' },
          value: {
            err: null,
            unitsConsumed: '10000',
            accounts: [...f.after, ...loaded.map((key) => accounts.get(key))],
            loadedAddresses: { writable: [], readonly: loaded },
            fee: '5000',
          },
        };
      }
      return f.base(method, params, signal);
    },
  );
  const result = await simulateCounterBuyPreparation(
    order,
    '5000',
    new AbortController().signal,
    rpc,
  );
  expect(result.balanceAssessment.status).toBe('Matched balances');
  const reads = rpc.mock.calls
    .filter((c) => c[0] === 'getMultipleAccounts')
    .map((c) => (c[1][0] as string[]).length);
  expect(reads).toContain(100);
  expect(reads).toContain(7);
  expect(reads.every((n) => n <= 100)).toBe(true);
  expect(
    rpc.mock.calls.find((c) => c[0] === 'simulateTransaction')?.[1][1],
  ).toMatchObject({ accounts: { addresses: keys } });
  let lookupRead = 0;
  await expect(
    simulateCounterBuyPreparation(
      order,
      '5000',
      new AbortController().signal,
      async (method, params, signal) => {
        if (
          method === 'getMultipleAccounts' &&
          (params[0] as string[])[0] === tableAddress &&
          ++lookupRead === 2
        ) {
          const changed = Uint8Array.from(table);
          changed[56] ^= 1;
          return {
            context: { slot: '101' },
            value: [raw(tableAccount.owner, changed, '1')],
          };
        }
        return rpc(method, params, signal);
      },
    ),
  ).rejects.toThrow(/changed during simulation|context slot|snapshot crossed/);
});
