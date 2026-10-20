import { expect, it, vi } from 'vitest';
import { marketplaceOwnedFixture } from '../test/marketplace-owned-fixture';
import { buildMarketplaceOwnedInventory } from './marketplace-owned-inventory';
import { inspectMarketplaceSaleWallet } from './marketplace-sale-inspection';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

vi.mock('./wallet-rpc-pacing', () => ({ paceWalletRpc: async () => {} }));
const at = Date.parse('2026-10-20T12:00:00.000Z');
function setup() {
  const fixture = marketplaceOwnedFixture(at);
  const inventory = buildMarketplaceOwnedInventory(fixture.sources, at);
  const read = vi.fn(async () => inventory);
  const controller = new AbortController();
  const selection = {
    address: fixture.a,
    walletRevision: 2,
    priceLamports: '100000000',
  };
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let account: unknown = {
    lamports: '9007199254740993',
    owner: '11111111111111111111111111111111',
    executable: false,
    space: '0',
    data: ['', 'base64'],
  };
  let floor = '100',
    accountSlot = '101',
    final = '102',
    genesis = SOLANA_MAINNET_GENESIS;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw Error('Expected JSON RPC body');
    const body = JSON.parse(init.body) as {
      method: string;
      params: unknown[];
    };
    calls.push(body);
    expect(init?.redirect).toBe('manual');
    expect(init?.cache).toBe('no-store');
    const result =
      body.method === 'getGenesisHash'
        ? genesis
        : body.method === 'getAccountInfo'
          ? { context: { slot: accountSlot }, value: account }
          : calls.length === 2
            ? floor
            : final;
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  const run = (now: () => number = () => at) =>
    inspectMarketplaceSaleWallet(read, selection, {
      signal: controller.signal,
      fetcher,
      now,
    });
  return {
    fixture,
    inventory,
    read,
    controller,
    selection,
    calls,
    fetcher,
    run,
    account: (value: unknown) => {
      account = value;
    },
    slots: (a: string, b: string, c: string) => {
      floor = a;
      accountSlot = b;
      final = c;
    },
    genesis: (value: string) => {
      genesis = value;
    },
  };
}
it('binds current u64 balance to the exact wallet, network and floors without granting sale authority', async () => {
  const f = setup(),
    result = await f.run();
  expect(result).toMatchObject({
    selection: f.selection,
    account: { kind: 'system-wallet', balanceLamports: '9007199254740993' },
    balanceDifferenceLamports: '9007198020173102',
    historicalBalanceLamports: '1234567891',
    currentControlVerified: false,
    tokenInventoryChecked: false,
    provenanceVerified: false,
    saleQualified: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  });
  expect(result.expiresAt).toBe('2026-10-20T12:01:00.000Z');
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.calls.map((v) => v.method)).toEqual([
    'getGenesisHash',
    'getSlot',
    'getAccountInfo',
    'getSlot',
  ]);
  expect(f.calls[2].params).toEqual([
    f.fixture.a,
    {
      commitment: 'confirmed',
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      minContextSlot: 100,
    },
  ]);
  expect(f.calls[3].params).toEqual([
    { commitment: 'confirmed', minContextSlot: 101 },
  ]);
  expect(JSON.stringify(result)).not.toContain('https://');
});
it('reports absent accounts and negative balance changes without inventing funding or creation dates', async () => {
  const f = setup();
  f.account(null);
  const result = await f.run();
  expect(result.account).toEqual({
    kind: 'absent',
    balanceLamports: '0',
    owner: null,
    executable: null,
    space: null,
  });
  expect(result.balanceDifferenceLamports).toBe('-1234567891');
  expect(result).not.toHaveProperty('createdAt');
  expect(result).not.toHaveProperty('fundedAt');
});
it.each([
  { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
  { executable: true },
  { space: '80' },
])(
  'reports unsupported accounts without promoting them to ordinary wallets: %j',
  async (patch) => {
    const f = setup();
    f.account({
      lamports: '1',
      owner: '11111111111111111111111111111111',
      executable: false,
      space: '0',
      data: ['', 'base64'],
      ...patch,
    });
    expect((await f.run()).account.kind).toBe('unsupported-account');
  },
);
it('keeps missing historical evidence unavailable rather than treating it as zero', async () => {
  const f = setup();
  f.selection.address = f.fixture.b;
  f.selection.walletRevision = 1;
  expect(await f.run()).toMatchObject({
    historicalControlProofAt: null,
    historicalBalanceLamports: null,
    balanceDifferenceLamports: null,
    currentControlVerified: false,
  });
});
it('refuses a foreign or changed wallet before provider reads', async () => {
  const f = setup();
  f.selection.walletRevision++;
  await expect(f.run()).rejects.toThrow('Seller wallet changed');
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(['revision', 'proof', 'history', 'archived'] as const)(
  'refuses %s source drift after provider reads',
  async (change) => {
    const f = setup(),
      after = structuredClone(f.fixture.sources);
    if (change === 'revision')
      (after.wallets[0] as { revision: number }).revision++;
    if (change === 'proof') after.proofs = [];
    if (change === 'history') after.runs = [];
    if (change === 'archived') {
      after.wallets = [];
      after.proofs = [];
      after.runs = [];
      after.receipts = [];
    }
    f.read
      .mockResolvedValueOnce(f.inventory)
      .mockResolvedValueOnce(buildMarketplaceOwnedInventory(after, at));
    await expect(f.run()).rejects.toThrow('evidence changed');
  },
);
it('refuses the wrong network before account reads', async () => {
  const f = setup();
  f.genesis('devnet');
  await expect(f.run()).rejects.toThrow('network differs');
  expect(f.calls).toHaveLength(1);
});
it.each([
  ['100', '99', '101'],
  ['100', '101', '100'],
  ['100', '101', '133'],
])('refuses reversed floors or a 33-slot span: %s/%s/%s', async (a, b, c) => {
  const f = setup();
  f.slots(a, b, c);
  await expect(f.run()).rejects.toThrow();
});
it('admits a 32-slot snapshot without authorizing a sale', async () => {
  const f = setup();
  f.slots('100', '110', '132');
  expect((await f.run()).saleQualified).toBe(false);
});
it.each(['18446744073709551616', '-1', '01', '1.5'])(
  'refuses invalid or overflowing lamports %s',
  async (lamports) => {
    const f = setup();
    f.account({
      lamports,
      owner: '11111111111111111111111111111111',
      executable: false,
      space: '0',
      data: ['', 'base64'],
    });
    await expect(f.run()).rejects.toThrow();
  },
);
it('preserves a numeric RPC u64 token before JavaScript rounding', async () => {
  const f = setup();
  f.fetcher
    .mockImplementationOnce(async () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS }),
    )
    .mockImplementationOnce(async () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: 100 }),
    )
    .mockImplementationOnce(
      async () =>
        new Response(
          '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":101},"value":{"lamports":18446744073709551615,"owner":"11111111111111111111111111111111","executable":false,"space":0,"data":["","base64"]}}}',
        ),
    )
    .mockImplementationOnce(async () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: 102 }),
    );
  expect((await f.run()).account.balanceLamports).toBe('18446744073709551615');
});
it('refuses an oversized provider response without retries', async () => {
  const f = setup();
  f.fetcher.mockResolvedValueOnce(new Response('x'.repeat(16385)));
  await expect(f.run()).rejects.toThrow('too large');
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('refuses malformed account evidence rather than calling it an absent wallet', async () => {
  const f = setup();
  f.account({ lamports: '1' });
  await expect(f.run()).rejects.toThrow();
});
it('refuses cancellation before and during transport, without retries', async () => {
  const f = setup();
  f.controller.abort();
  await expect(f.run()).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
  const g = setup();
  g.fetcher.mockImplementationOnce(async () => {
    g.controller.abort();
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: SOLANA_MAINNET_GENESIS,
    });
  });
  await expect(g.run()).rejects.toThrow();
  expect(g.fetcher).toHaveBeenCalledTimes(1);
});
it('stops on a provider 429 without retrying or rechecking saved sources', async () => {
  const f = setup();
  f.fetcher.mockResolvedValueOnce(new Response('', { status: 429 }));
  await expect(f.run()).rejects.toThrow('provider unavailable');
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.read).toHaveBeenCalledTimes(1);
});
it.each([60000, -1])(
  'refuses an expired or reversed server clock (%s ms)',
  async (delta) => {
    const f = setup();
    let calls = 0;
    await expect(
      f.run(() => (++calls < 4 ? at : at + delta)),
    ).rejects.toThrow();
  },
);
