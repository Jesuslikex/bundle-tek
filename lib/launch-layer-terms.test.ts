import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import { quoteCatalog } from './quote-catalog';
import {
  createLaunchLayerTerms,
  verifyLaunchLayerTerms,
  type LaunchLayerContext,
  type LaunchLayerRequest,
} from './launch-layer-terms';

const address = (n: number) =>
  bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 7)));
function fixture() {
  const member = (n: number, buy: string) => ({
    wallet: {
      address: address(n),
      revision: 2,
      root: true as const,
      folderRevision: 0,
    },
    maximumBuyQuoteRaw: buy,
    maximumNetworkFeeLamports: '5000',
    maximumAccountRentLamports: '2000000',
    retainedNativeReserveLamports: '100000',
  });
  const input: LaunchLayerRequest = {
    roles: {
      funder: member(1, '0'),
      developer: member(2, '100'),
      front: [member(3, '1000')],
      back: [member(4, '300')],
      temporary: [member(5, '0')],
      holders: [member(6, '0'), member(7, '0')],
    },
    delays: {
      fundingDelaySeconds: 1,
      frontToBackDelayMs: 700,
      backToTemporaryDelayMs: 500,
    },
  };
  const context: LaunchLayerContext = {
    ownerId: 'alice',
    savedPlan: {
      ...DEFAULT_LAUNCH_PLAN,
      holderCount: 2,
      updatedAt: '2026-10-18T03:00:00.123Z',
    },
    target: { kind: 'new', mint: address(99) },
    workspace: {
      folders: [],
      wallets: Array.from({ length: 7 }, (_, i) => ({
        address: address(i + 1),
        chain: 'Solana',
        folderId: '',
        label: 'Synthetic owned public address',
        role: 'Recipient',
        revision: 2,
        archived: false,
        updatedAt: '2026-10-18T03:00:00.000Z',
      })),
    },
  };
  return { input, context };
}
it('captures ordered owned roles with exact native ceilings and no authority', async () => {
  const { input, context } = fixture();
  const envelope = await createLaunchLayerTerms(input, context);
  expect(envelope.terms.quote).toMatchObject({
    kind: 'native',
    symbol: 'SOL',
    decimals: 9,
  });
  expect(envelope.terms.totals).toEqual({
    maximumBuyQuoteRaw: '1400',
    maximumNetworkFeeLamports: '35000',
    maximumAccountRentLamports: '14000000',
    retainedNativeReserveLamports: '700000',
    maximumNativeBudgetLamports: '14736400',
  });
  expect(envelope.terms).toMatchObject({
    protocol: 'buyback',
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(envelope.terms.roles.holders).toHaveLength(2);
  expect(envelope.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(
    await verifyLaunchLayerTerms(JSON.parse(JSON.stringify(envelope)), context),
  ).toEqual(envelope);
  expect(envelope.terms).not.toHaveProperty('requiredFunding');
  input.roles.front[0].maximumBuyQuoteRaw = '999';
  expect(envelope.terms.roles.front[0].maximumBuyQuoteRaw).toBe('1000');
});
it('keeps custom quote ceilings out of native fees and reserves', async () => {
  const { input, context } = fixture();
  const usdc = quoteCatalog('Solana', 'PumpFun').assets.find(
    (a) => a.symbol === 'USDC',
  )!;
  context.savedPlan.currency = 'USDC';
  context.savedPlan.quoteAddress = usdc.address;
  input.roles.front[0].maximumBuyQuoteRaw = '9007199254740993';
  const { terms } = await createLaunchLayerTerms(input, context);
  expect(terms.quote).toMatchObject({
    kind: 'token',
    address: usdc.address,
    decimals: 6,
  });
  expect(terms.totals.maximumBuyQuoteRaw).toBe('9007199254741393');
  expect(terms.totals.maximumNativeBudgetLamports).toBe('14735000');
});
it('enforces the StonkFun Front-only policy without enabling stock signing', async () => {
  const { input, context } = fixture();
  context.savedPlan.launchpad = 'StonkFun';
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
    'StonkFun',
  );
  input.roles.back = [];
  input.roles.temporary = [];
  input.delays.frontToBackDelayMs = 0;
  input.delays.backToTemporaryDelayMs = 0;
  const stock = quoteCatalog('Solana', 'StonkFun').assets.find(
    (a) => a.symbol === 'TSLAX',
  )!;
  context.savedPlan.currency = 'TSLAX';
  context.savedPlan.quoteAddress = stock.address;
  const { terms } = await createLaunchLayerTerms(input, context);
  expect(terms.quote.address).toBe(stock.address);
  expect(terms.quote.evidence).toBe('saved-catalog-units-only');
  expect(terms.signingAllowed).toBe(false);
  for (let n = 8; n <= 19; n++) {
    context.workspace.wallets.push({
      ...context.workspace.wallets[0],
      address: address(n),
    });
    input.roles.front.push({
      ...input.roles.front[0],
      wallet: { ...input.roles.front[0].wallet, address: address(n) },
    });
  }
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
    'at most 12',
  );
});
it('distinguishes new-token authority from scheduled imported-token terms', async () => {
  const { input, context } = fixture();
  context.target.kind = 'imported';
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
    'scheduled',
  );
  context.savedPlan.scheduled = true;
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
    'cannot claim',
  );
  delete input.roles.developer;
  expect(
    (await createLaunchLayerTerms(input, context)).terms.binding.target.kind,
  ).toBe('imported');
  context.target.kind = 'new';
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
    'developer',
  );
});
it.each(['archive', 'revision', 'missing', 'duplicate', 'folder'] as const)(
  'refuses a changed owned wallet: %s',
  async (change) => {
    const { input, context } = fixture();
    const wallet = context.workspace.wallets[2];
    if (change === 'archive') wallet.archived = true;
    if (change === 'revision') wallet.revision++;
    if (change === 'missing') context.workspace.wallets.splice(2, 1);
    if (change === 'duplicate') context.workspace.wallets.push({ ...wallet });
    if (change === 'folder') {
      input.roles.front[0].wallet = {
        address: wallet.address,
        revision: 2,
        folderRevision: 3,
        folderId: 'folder',
      };
      wallet.folderId = 'folder';
      context.workspace.folders.push({
        id: 'folder',
        name: 'Archived',
        chain: 'Solana',
        revision: 3,
        archived: true,
        updatedAt: '',
      });
    }
    await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
      'Reselect',
    );
  },
);
it('revalidates exact folder references and preserves explicit parent-wallet semantics', async () => {
  const { input, context } = fixture();
  const wallet = context.workspace.wallets[2];
  wallet.folderId = 'folder';
  context.workspace.folders.push({
    id: 'folder',
    name: 'Active',
    chain: 'Solana',
    revision: 3,
    archived: false,
    updatedAt: '',
  });
  input.roles.front[0].wallet = {
    address: wallet.address,
    revision: 2,
    folderRevision: 3,
    folderId: 'folder',
  };
  const envelope = await createLaunchLayerTerms(input, context);
  context.workspace.folders[0].revision++;
  await expect(verifyLaunchLayerTerms(envelope, context)).rejects.toThrow(
    'Reselect',
  );
  input.roles.front[0].wallet = {
    address: wallet.address,
    revision: 2,
    folderRevision: 0,
    root: true,
  };
  expect(
    (await createLaunchLayerTerms(input, context)).terms.roles.front[0].wallet
      .root,
  ).toBe(true);
});
it.each([
  'owner',
  'saved-time',
  'saved-plan',
  'target',
  'budget',
  'digest',
  'authority',
  'unknown-field',
  'order',
  'quote-units',
  'quote-kind',
  'totals',
  'protocol',
] as const)('refuses stale or tampered retained terms: %s', async (change) => {
  const { input, context } = fixture();
  const envelope = await createLaunchLayerTerms(input, context);
  if (change === 'owner') context.ownerId = 'bob';
  if (change === 'saved-time')
    context.savedPlan.updatedAt = '2026-10-18T03:01:00.123Z';
  if (change === 'saved-plan') context.savedPlan.tokenName = 'Different';
  if (change === 'target') context.target.mint = address(98);
  if (change === 'budget')
    envelope.terms.roles.front[0].maximumBuyQuoteRaw = '1001';
  if (change === 'digest') envelope.sha256 = '0'.repeat(64);
  if (change === 'authority')
    Object.assign(envelope.terms, { signingAllowed: true });
  if (change === 'unknown-field')
    Object.assign(envelope.terms, { approved: true });
  if (change === 'order') envelope.terms.roles.holders.reverse();
  if (change === 'quote-units') envelope.terms.quote.decimals = 6;
  if (change === 'quote-kind') envelope.terms.quote.kind = 'token';
  if (change === 'totals')
    envelope.terms.totals.maximumNativeBudgetLamports = '1';
  if (change === 'protocol')
    Object.assign(envelope.terms, { protocol: 'airdrop' });
  await expect(verifyLaunchLayerTerms(envelope, context)).rejects.toThrow();
});
it.each([
  '-1',
  '01',
  '1.0',
  '1e9',
  ' 1',
  '18446744073709551616',
  '9'.repeat(100),
])('refuses inexact or overflowing atomic budgets: %s', async (amount) => {
  const { input, context } = fixture();
  input.roles.front[0].maximumBuyQuoteRaw = amount;
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow();
});
it('refuses native budget overflow and hidden fields including keys', async () => {
  const { input, context } = fixture();
  input.roles.front[0].maximumBuyQuoteRaw = '18446744073709551615';
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
    'Per-wallet',
  );
  input.roles.front[0].maximumBuyQuoteRaw = '1000';
  Object.assign(input.roles.front[0].wallet, {
    secret: 'synthetic-rejected-value',
  });
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow();
});
it('keeps funding seconds and layer milliseconds exact and refuses inactive or malformed roles', async () => {
  for (const key of [
    'fundingDelaySeconds',
    'frontToBackDelayMs',
    'backToTemporaryDelayMs',
  ] as const) {
    const { input, context } = fixture();
    input.delays[key] = 0.5;
    await expect(createLaunchLayerTerms(input, context)).rejects.toThrow();
  }
  for (const role of ['funder', 'temporary'] as const) {
    const { input, context } = fixture();
    const member =
      role === 'funder' ? input.roles.funder : input.roles.temporary[0];
    member.maximumBuyQuoteRaw = '1';
    await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
      'cannot claim purchase',
    );
  }
  const { input, context } = fixture();
  input.roles.front[0].wallet.address = '1'.repeat(10000);
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
    'public address',
  );
});
it('refuses duplicate roles, wrong holder counts and absent layer delays', async () => {
  const { input, context } = fixture();
  input.roles.back[0].wallet = { ...input.roles.front[0].wallet };
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
    'unique',
  );
  input.roles.back = [];
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
    'Back layer',
  );
  input.roles.temporary = [];
  input.delays.frontToBackDelayMs = 0;
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
    'temporary layer',
  );
  input.delays.backToTemporaryDelayMs = 0;
  context.savedPlan.holderCount = 3;
  await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
    'holder count',
  );
});
it('refuses moving context while the asynchronous digest is pending', async () => {
  const { input, context } = fixture();
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi
    .spyOn(crypto.subtle, 'digest')
    .mockImplementation(async (...args) => {
      context.workspace.wallets[2].revision++;
      return original(...args);
    });
  try {
    await expect(createLaunchLayerTerms(input, context)).rejects.toThrow(
      'Reselect',
    );
  } finally {
    spy.mockRestore();
  }
});
