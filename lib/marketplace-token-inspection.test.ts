import { expect, it, vi } from 'vitest';
import { getExtensionEncoder } from '@solana-program/token-2022';
import { address } from '@solana/kit';
import { marketplaceTokenInspectionFixture } from '../test/marketplace-token-inspection-fixture';
import {
  inspectMarketplaceSaleTokens,
  decodeMarketplaceTokenAccount,
} from './marketplace-token-inspection';
import {
  MARKETPLACE_TOKEN_PROGRAMS as programs,
  admitMarketplaceTokenInspection,
} from './marketplace-token-inspection-view';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
vi.mock('./wallet-rpc-pacing', () => ({ paceWalletRpc: async () => {} }));
const now = Date.parse('2026-10-20T12:00:00.000Z');
function setup() {
  const f = marketplaceTokenInspectionFixture(now),
    read = vi.fn(async () => f.inventory),
    stop = new AbortController();
  const responses: unknown[][] = [
    [f.account().raw],
    [
      f.account({
        id: 4,
        program: programs[1],
        amount: 0n,
        extensions: [{ __kind: 'ImmutableOwner' }],
      }).raw,
    ],
  ];
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let genesis = SOLANA_MAINNET_GENESIS;
  let slots = ['100', '101', '102', '103'];
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw Error('Expected RPC JSON');
    const body = JSON.parse(init.body) as { method: string; params: unknown[] };
    calls.push(body);
    let result: unknown;
    if (body.method === 'getGenesisHash') result = genesis;
    else if (body.method === 'getSlot')
      result =
        (body.params[0] as { minContextSlot?: number }).minContextSlot ===
        undefined
          ? slots[0]
          : slots[3];
    else {
      const index =
        (body.params[1] as { programId: string }).programId === programs[0]
          ? 0
          : 1;
      result = { context: { slot: slots[index + 1] }, value: responses[index] };
    }
    expect(init.redirect).toBe('manual');
    expect(init.cache).toBe('no-store');
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  const run = (clock: () => number = () => now) =>
    inspectMarketplaceSaleTokens(read, f.selection, {
      signal: stop.signal,
      fetcher,
      now: clock,
    });
  return {
    f,
    read,
    stop,
    calls,
    responses,
    fetcher,
    run,
    slots: (value: string[]) => {
      slots = value;
    },
    genesis: (value: string) => {
      genesis = value;
    },
  };
}
it('enumerates both programs with advancing floors, decodes raw amounts and admits the exact owned response', async () => {
  const t = setup(),
    result = await t.run();
  expect(t.calls.map((c) => c.method)).toEqual([
    'getGenesisHash',
    'getSlot',
    'getTokenAccountsByOwner',
    'getTokenAccountsByOwner',
    'getSlot',
  ]);
  expect(t.calls[2].params).toEqual([
    t.f.source.a,
    { programId: programs[0] },
    { encoding: 'base64', commitment: 'confirmed', minContextSlot: 100 },
  ]);
  expect(t.calls[3].params[2]).toEqual({
    encoding: 'base64',
    commitment: 'confirmed',
    minContextSlot: 101,
  });
  expect(t.calls[4].params).toEqual([
    { commitment: 'confirmed', minContextSlot: 102 },
  ]);
  expect(result).toMatchObject({
    accountCount: 2,
    nonzeroRawAccounts: 1,
    extendedAccounts: 1,
    allAssetsAndAuthoritiesChecked: false,
    extensionSemanticsChecked: false,
    saleQualified: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  });
  expect(result.accounts[1].extensions).toEqual(['ImmutableOwner']);
  expect(
    await admitMarketplaceTokenInspection(
      { inspection: result },
      t.f.inventory,
      t.f.selection,
      now,
    ),
  ).toEqual(result);
  expect(t.read).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain('https://');
});
it('reports an empty response from both programs without claiming all assets or authorities were checked', async () => {
  const t = setup();
  t.responses[0] = [];
  t.responses[1] = [];
  const r = await t.run();
  expect(r.accountCount).toBe(0);
  expect(r.allAssetsAndAuthoritiesChecked).toBe(false);
  expect(r.coverage).toContain('No empty-wallet');
  expect(
    await admitMarketplaceTokenInspection(
      { inspection: r },
      t.f.inventory,
      t.f.selection,
      now,
    ),
  ).toEqual(r);
});
it('keeps u64 units exact and reports frozen, delegate and foreign close authorities even with zero raw units', async () => {
  const t = setup();
  t.responses[0] = [
    t.f.account({
      amount: (1n << 64n) - 1n,
      delegate: t.f.key(8),
      delegatedAmount: 100n,
      closeAuthority: t.f.key(9),
      frozen: true,
    }).raw,
  ];
  const result = await t.run();
  expect(result.accounts[0]).toMatchObject({
    amountRaw: '18446744073709551615',
    delegatedAmountRaw: '100',
    delegate: t.f.key(8),
    closeAuthority: t.f.key(9),
    state: 'frozen',
  });
  expect(result).toMatchObject({
    frozenAccounts: 1,
    delegatedAccounts: 1,
    foreignCloseAuthorities: 1,
  });
  t.responses[0] = [
    t.f.account({
      amount: 0n,
      delegate: t.f.key(8),
      closeAuthority: t.f.key(9),
    }).raw,
  ];
  expect(await t.run()).toMatchObject({
    nonzeroRawAccounts: 0,
    delegatedAccounts: 1,
    foreignCloseAuthorities: 1,
  });
});
it.each([
  'owner',
  'program',
  'state',
  'executable',
  'space',
  'encoding',
  'delegate-option',
  'close-option',
  'native-option',
  'inactive-delegation',
  'reserve',
  'short',
  'legacy-extra',
  'duplicate',
])(
  'refuses malformed or mismatched %s evidence instead of reporting an empty inventory',
  async (change) => {
    const t = setup(),
      a = t.f.account();
    if (change === 'owner') a.bytes.fill(9, 32, 64);
    if (change === 'program') a.raw.account.owner = programs[1];
    if (change === 'state') a.bytes[108] = 0;
    if (change === 'executable') a.raw.account.executable = true;
    if (change === 'space') a.raw.account.space = '164';
    if (change === 'delegate-option') a.bytes[72] = 2;
    if (change === 'close-option') a.bytes[129] = 2;
    if (change === 'native-option') a.bytes[109] = 2;
    if (change === 'inactive-delegation') a.bytes[121] = 1;
    if (change === 'reserve') {
      a.bytes[109] = 1;
      new DataView(a.bytes.buffer).setBigUint64(113, 2039281n, true);
    }
    a.rewrite();
    if (change === 'encoding') a.raw.account.data[0] += '\n';
    if (change === 'short') {
      a.raw.account.data[0] = btoa('x'.repeat(164));
      a.raw.account.space = '164';
    }
    if (change === 'legacy-extra') {
      a.raw.account.data[0] = btoa('x'.repeat(166));
      a.raw.account.space = '166';
    }
    t.responses[0] = change === 'duplicate' ? [a.raw, a.raw] : [a.raw];
    await expect(t.run()).rejects.toThrow();
  },
);
it('decodes native reserve and preserves inactive option payload without inventing an authority', async () => {
  const t = setup(),
    a = t.f.account({ amount: 0n, nativeReserve: 2039280n });
  a.bytes.fill(5, 76, 108);
  a.rewrite();
  t.responses[0] = [a.raw];
  const result = await t.run();
  expect(result.accounts[0]).toMatchObject({
    nativeReserveRaw: '2039280',
    delegate: null,
  });
});
it.each([
  'duplicate-extension',
  'unknown-extension',
  'truncated-extension',
  'mint-extension',
  'wrong-discriminator',
])(
  'refuses %s in Token-2022 rather than accepting a program ID alone',
  async (change) => {
    const t = setup(),
      a = t.f.account({
        id: 4,
        program: programs[1],
        extensions: [{ __kind: 'ImmutableOwner' }],
      });
    let bytes = a.bytes;
    if (change === 'duplicate-extension')
      bytes = Uint8Array.from([
        ...a.bytes,
        ...getExtensionEncoder().encode({ __kind: 'ImmutableOwner' }),
      ]);
    if (change === 'unknown-extension') {
      bytes[166] = 255;
      bytes[167] = 255;
    }
    if (change === 'truncated-extension') bytes[168] = 4;
    if (change === 'mint-extension')
      bytes = Uint8Array.from([
        ...a.bytes.slice(0, 166),
        ...getExtensionEncoder().encode({
          __kind: 'MintCloseAuthority',
          closeAuthority: address(t.f.key(8)),
        }),
      ]);
    if (change === 'wrong-discriminator') bytes[165] = 1;
    a.raw.account.space = String(bytes.length);
    a.raw.account.data[0] = btoa(String.fromCharCode(...bytes));
    t.responses[1] = [a.raw];
    await expect(t.run()).rejects.toThrow();
  },
);
it('recognizes account extensions without claiming their transfer or confidential semantics', async () => {
  const t = setup();
  t.responses[1] = [
    t.f.account({
      id: 4,
      program: programs[1],
      extensions: [
        { __kind: 'MemoTransfer', requireIncomingTransferMemos: true },
        { __kind: 'TransferFeeAmount', withheldAmount: 100n },
      ],
    }).raw,
  ];
  expect((await t.run()).accounts[1].extensions).toEqual([
    'MemoTransfer',
    'TransferFeeAmount',
  ]);
  expect((await t.run()).extensionSemanticsChecked).toBe(false);
});
it('refuses enumeration above 200 across programs, preserving an all-or-nothing result', async () => {
  const t = setup();
  t.responses[0] = Array.from(
    { length: 200 },
    (_, i) => t.f.account({ id: i + 3 }).raw,
  );
  t.responses[1] = [t.f.account({ id: 250, program: programs[1] }).raw];
  await expect(t.run()).rejects.toThrow('limit');
});
it.each([
  ['100', '99', '101', '102'],
  ['100', '102', '101', '103'],
  ['100', '101', '102', '101'],
  ['100', '101', '102', '133'],
])('refuses reversed or stale slot evidence: %j', async (...slots) => {
  const t = setup();
  t.slots(slots);
  await expect(t.run()).rejects.toThrow();
});
it('accepts exactly 32 slots with separate per-program observation slots', async () => {
  const t = setup();
  t.slots(['100', '110', '120', '132']);
  const r = await t.run();
  expect(r.programs.map((p) => p.slot)).toEqual([110, 120]);
  expect(r.accounts.map((a) => a.slot)).toEqual([110, 120]);
});
it('requires an exact owned revision before providers and unchanged seller sources afterwards', async () => {
  const t = setup();
  t.f.selection.walletRevision++;
  await expect(t.run()).rejects.toThrow('Seller wallet changed');
  expect(t.fetcher).not.toHaveBeenCalled();
  const other = setup(),
    changed = structuredClone(other.f.inventory);
  changed.wallets[0].ownershipProofAt = null;
  other.read
    .mockResolvedValueOnce(other.f.inventory)
    .mockResolvedValueOnce(changed);
  await expect(other.run()).rejects.toThrow('evidence changed');
});
it('does not retry a 429 or publish partial accounts when the second program fails', async () => {
  const t = setup();
  const original = t.fetcher.getMockImplementation()!;
  t.fetcher.mockImplementation(async (url, init) => {
    if (typeof init?.body === 'string' && init.body.includes(programs[1]))
      return new Response('private provider error', { status: 429 });
    return original(url, init);
  });
  await expect(t.run()).rejects.toThrow('provider unavailable');
  expect(t.fetcher).toHaveBeenCalledTimes(4);
  expect(t.read).toHaveBeenCalledTimes(1);
});
it('refuses wrong network, cancellation and expired server time', async () => {
  const t = setup();
  t.genesis('devnet');
  await expect(t.run()).rejects.toThrow('network differs');
  expect(t.fetcher).toHaveBeenCalledTimes(1);
  const cancelled = setup();
  cancelled.stop.abort();
  await expect(cancelled.run()).rejects.toThrow();
  expect(cancelled.read).not.toHaveBeenCalled();
  const expired = setup();
  let n = 0;
  await expect(
    expired.run(() => (++n < 4 ? now : now + 60000)),
  ).rejects.toThrow();
});
it('validates standalone decoder inputs instead of trusting supplied wallet or program strings', async () => {
  const f = marketplaceTokenInspectionFixture(now);
  await expect(
    decodeMarketplaceTokenAccount(f.account().raw, programs[0], 'bad', 100),
  ).rejects.toThrow();
});
it('supports exactly 200 accounts without truncation and admits every row', async () => {
  const t = setup();
  t.responses[0] = Array.from(
    { length: 200 },
    (_, i) => t.f.account({ id: i + 3 }).raw,
  );
  t.responses[1] = [];
  const result = await t.run();
  expect(result.accounts).toHaveLength(200);
  expect(
    await admitMarketplaceTokenInspection(
      { inspection: result },
      t.f.inventory,
      t.f.selection,
      now,
    ),
  ).toEqual(result);
});
it('accepts reserved zero padding but refuses a noncanonical known extension boolean', async () => {
  const t = setup(),
    padded = t.f.account({
      id: 4,
      program: programs[1],
      extensions: [{ __kind: 'ImmutableOwner' }],
    });
  const bytes = Uint8Array.from([...padded.bytes, 0, 0, 0]);
  padded.raw.account.space = String(bytes.length);
  padded.raw.account.data[0] = btoa(String.fromCharCode(...bytes));
  t.responses[1] = [padded.raw];
  expect((await t.run()).accounts[1].extensions).toEqual(['ImmutableOwner']);
  const invalid = t.f.account({
    id: 4,
    program: programs[1],
    extensions: [
      { __kind: 'MemoTransfer', requireIncomingTransferMemos: true },
    ],
  });
  invalid.bytes[170] = 2;
  invalid.rewrite();
  t.responses[1] = [invalid.raw];
  await expect(t.run()).rejects.toThrow('encoding differs');
});
it.each([
  'amount',
  'owner',
  'program-slot',
  'program-order',
  'duplicate',
  'order',
  'count',
  'summary',
  'authority',
  'hash',
  'price',
  'future',
  'expiry',
  'span',
  'delegate',
  'extension',
  'legacy-size',
  'absent-program',
  'missing-amount',
])(
  'client admission refuses altered %s evidence rather than presenting it as a verified inspection',
  async (change) => {
    const t = setup(),
      result = await t.run();
    if (change === 'amount')
      result.accounts[0].amountRaw = '18446744073709551616';
    if (change === 'owner') result.accounts[0].walletOwner = t.f.source.b;
    if (change === 'program-slot') result.accounts[0].slot++;
    if (change === 'program-order') result.programs.reverse();
    if (change === 'duplicate') result.accounts.push(result.accounts[0]);
    if (change === 'order') result.accounts.reverse();
    if (change === 'count') result.programs[0].count++;
    if (change === 'summary') result.nonzeroRawAccounts++;
    if (change === 'authority') Object.assign(result, { signingAllowed: true });
    if (change === 'hash') result.sellerEvidenceSha256 = 'a'.repeat(64);
    if (change === 'price') result.selection.priceLamports = '1';
    if (change === 'future')
      result.observedAt = new Date(now + 1).toISOString();
    if (change === 'expiry')
      result.expiresAt = new Date(now + 60001).toISOString();
    if (change === 'span') result.finalSlot = result.floorSlot + 33;
    if (change === 'delegate') result.accounts[0].delegatedAmountRaw = '1';
    if (change === 'extension')
      result.accounts[1].extensions.push('ImmutableOwner');
    if (change === 'legacy-size') result.accounts[0].byteLength++;
    if (change === 'absent-program') result.programs.pop();
    if (change === 'missing-amount')
      Reflect.deleteProperty(result.accounts[0], 'amountRaw');
    await expect(
      admitMarketplaceTokenInspection(
        { inspection: result },
        t.f.inventory,
        t.f.selection,
        now,
      ),
    ).rejects.toThrow();
  },
);
it('client admission refuses expiry, noncanonical time and extra envelope fields', async () => {
  const t = setup(),
    result = await t.run();
  await expect(
    admitMarketplaceTokenInspection(
      { inspection: result },
      t.f.inventory,
      t.f.selection,
      now + 60000,
    ),
  ).rejects.toThrow();
  await expect(
    admitMarketplaceTokenInspection(
      { inspection: result, authorized: true },
      t.f.inventory,
      t.f.selection,
      now,
    ),
  ).rejects.toThrow();
  result.observedAt = result.observedAt.replace('.000Z', 'Z');
  await expect(
    admitMarketplaceTokenInspection(
      { inspection: result },
      t.f.inventory,
      t.f.selection,
      now,
    ),
  ).rejects.toThrow();
});
