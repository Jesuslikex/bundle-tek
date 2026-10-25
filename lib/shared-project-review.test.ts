import { expect, it } from 'vitest';
import {
  decodeSharedProjectSnapshots,
  readSharedProjectSnapshots,
  createScopedSharedProjectSnapshot,
  type ScopedSharedProjectSnapshot,
} from './shared-project-review';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import { EMPTY_IDENTITY, DEFAULT_VENUE_OPTIONS } from './workspace-project';
import type { ProjectShareScope } from './project-share-scope';
const saved = () => ({
  id: 'shared-plan-a',
  shareId: '11111111-1111-4111-8111-111111111111',
  readOnly: true,
  archived: false,
  updatedAt: '2026-10-24T08:00:00.000Z',
  plan: structuredClone(DEFAULT_LAUNCH_PLAN),
  identity: {
    ...EMPTY_IDENTITY,
    artworkUrl: 'https://example.invalid/art.png',
    website: 'https://example.invalid/site',
    twitter: 'https://example.invalid/social',
    telegram: 'https://example.invalid/chat',
  },
  options: structuredClone(DEFAULT_VENUE_OPTIONS),
});
it('retains a validated display snapshot while excluding artwork URLs, wallet references and identity links', () => {
  const value = saved();
  value.options.wallets = {
    chain: 'Solana',
    recipients: [
      {
        address: '11111111111111111111111111111111',
        revision: 1,
        folderRevision: 0,
        root: true,
      },
    ],
  };
  value.options.wallets.deployer = {
    address: 'SysvarRent111111111111111111111111111111111',
    revision: 1,
    folderRevision: 0,
    root: true,
  };
  value.options.settings.pumpfun.feeSharing = true;
  value.options.settings.pumpfun.feeShares = [
    { address: 'SysvarC1ock11111111111111111111111111111111', shareBps: 10000 },
  ];
  const [result] = decodeSharedProjectSnapshots({ projects: [value] });
  expect(result).toMatchObject({
    readOnly: true,
    artworkSaved: true,
    assignedRecipients: 1,
    deployerAssigned: true,
    totalSupply: '1000000000',
  });
  const text = JSON.stringify(result);
  expect(text).not.toContain('art.png');
  expect(text).not.toContain('example.invalid');
  expect(text).not.toContain('11111111111111111111111111111111');
  expect(text).not.toContain('wallets');
  expect(text).not.toContain('SysvarRent');
  expect(text).not.toContain('SysvarC1ock');
  value.plan.tokenName = 'Changed input';
  expect(result.plan.tokenName).not.toBe('Changed input');
});
it.each([undefined, false, 'true'])(
  'refuses missing or non-true read-only flags (%s)',
  (readOnly) => {
    expect(() =>
      decodeSharedProjectSnapshots({ projects: [{ ...saved(), readOnly }] }),
    ).toThrow('Shared projects unavailable');
  },
);
it.each([
  { updatedAt: 'yesterday' },
  { updatedAt: '2026-10-24T08:00:00Z' },
  { shareId: 'not-an-id' },
  { id: '../project' },
  { archived: 1 },
  { extraPermission: true },
])('refuses malformed metadata %j', (change) => {
  expect(() =>
    decodeSharedProjectSnapshots({ projects: [{ ...saved(), ...change }] }),
  ).toThrow('Shared projects unavailable');
});
it('refuses malformed document terms and duplicate share IDs', () => {
  const value = saved();
  expect(() =>
    decodeSharedProjectSnapshots({ projects: [value, value] }),
  ).toThrow();
  expect(() =>
    decodeSharedProjectSnapshots({
      projects: [{ ...value, plan: { ...value.plan, developerBuy: '5' } }],
    }),
  ).toThrow();
  expect(() =>
    decodeSharedProjectSnapshots({
      projects: [{ ...value, plan: { ...value.plan, developerBuy: 101 } }],
    }),
  ).toThrow();
});
it('refuses over-cap pages and unknown envelope fields', () => {
  expect(() =>
    decodeSharedProjectSnapshots({
      projects: Array.from({ length: 101 }, saved),
    }),
  ).toThrow();
  expect(() =>
    decodeSharedProjectSnapshots({ projects: [], extra: true }),
  ).toThrow();
  expect(decodeSharedProjectSnapshots({ projects: [] })).toEqual([]);
});
it('refuses an accessor without running it', () => {
  let invoked = false;
  const value = saved();
  Object.defineProperty(value, 'plan', {
    enumerable: true,
    get() {
      invoked = true;
      return DEFAULT_LAUNCH_PLAN;
    },
  });
  expect(() => decodeSharedProjectSnapshots({ projects: [value] })).toThrow();
  expect(invoked).toBe(false);
});
it('bounded response admission rejects HTML and never exposes its content', async () => {
  await expect(
    readSharedProjectSnapshots(
      new Response('<html>private parser detail</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    ),
  ).rejects.toThrow('Shared projects unavailable. Try again later.');
  await expect(
    readSharedProjectSnapshots(Response.json({ projects: [] })),
  ).resolves.toEqual([]);
  await expect(
    readSharedProjectSnapshots(new Response(null, { status: 401 })),
  ).rejects.toThrow('Sign in to open shared projects.');
});

it('admits canonical expiry and explicit legacy null without weakening private-field projection', () => {
  const expiresAt = '2026-10-26T00:00:00.000Z';
  expect(
    decodeSharedProjectSnapshots({ projects: [{ ...saved(), expiresAt }] }),
  ).toMatchObject([{ expiresAt, readOnly: true }]);
  expect(
    decodeSharedProjectSnapshots({
      projects: [{ ...saved(), expiresAt: null }],
    }),
  ).toMatchObject([{ expiresAt: null }]);
  for (const expiresAt of ['invalid', '2026-10-26', {}, 12, undefined])
    expect(() =>
      decodeSharedProjectSnapshots({ projects: [{ ...saved(), expiresAt }] }),
    ).toThrow('Shared projects unavailable');
});

const recipient = '11111111111111111111111111111111';
const deployer = 'SysvarRent111111111111111111111111111111111';
const other = 'SysvarC1ock11111111111111111111111111111111';
function scopeFixture() {
  const value = saved();
  value.options.wallets = {
    chain: 'Solana',
    recipients: [
      {
        address: recipient,
        revision: 1,
        folderRevision: 1,
        folderId: 'private-folder',
      },
    ],
    deployer: { address: deployer, revision: 2, folderRevision: 0, root: true },
  };
  value.options.settings.pumpfun.feeSharing = true;
  value.options.settings.pumpfun.feeShares = [
    { address: other, shareBps: 10000 },
  ];
  const meta = {
    id: value.id,
    shareId: value.shareId,
    archived: value.archived,
    updatedAt: value.updatedAt,
    expiresAt: '2026-10-26T00:00:00.000Z',
  };
  const document = {
    plan: value.plan,
    identity: value.identity,
    options: { ...value.options, wallets: value.options.wallets },
  };
  const scope: ProjectShareScope = {
    format: 'project-share-wallet-scope-v1',
    projectRevision: value.updatedAt,
    wallets: [
      { chain: 'Solana', address: recipient, revision: 1, role: 'Recipient' },
    ],
  };
  return { meta, document, scope };
}
function scoped() {
  const f = scopeFixture();
  return createScopedSharedProjectSnapshot(f.meta, f.document, f.scope);
}
function readScoped(value: unknown) {
  return decodeSharedProjectSnapshots({ projects: [value] })[0];
}

it('keeps omitted metadata editing permissions on the v1 wire format', () => {
  const value = scoped();
  expect(value.format).toBe('shared-project-scoped-v1');
  expect(Object.hasOwn(value, 'permissions')).toBe(false);
  expect(readScoped(value)).toEqual(value);
});

it.each([false, true])(
  'round trips explicit metadata editing permission %s only as v2',
  (editMetadata) => {
    const f = scopeFixture();
    const permissions = { editMetadata };
    const value = createScopedSharedProjectSnapshot(
      f.meta,
      f.document,
      f.scope,
      permissions,
    );
    expect(value).toMatchObject({
      format: 'shared-project-scoped-v2',
      readOnly: true,
      permissions: { editMetadata },
    });
    const decoded = readScoped(value);
    expect(decoded).toEqual(value);
    permissions.editMetadata = !editMetadata;
    expect(value.permissions).toEqual({ editMetadata });
    value.permissions!.editMetadata = !editMetadata;
    expect(decoded.permissions).toEqual({ editMetadata });
  },
);

it.each([
  undefined,
  null,
  {},
  { editMetadata: undefined },
  { editMetadata: 1 },
  { editMetadata: 'true' },
  { editMetadata: false, signingAllowed: true },
  { editMetadata: true, publishingAllowed: true },
])(
  'refuses incomplete, nonboolean or expanded v2 permissions %j',
  (permissions) => {
    expect(() =>
      readScoped({
        ...scoped(),
        format: 'shared-project-scoped-v2',
        permissions,
      }),
    ).toThrow('Shared projects unavailable');
  },
);

it('requires a v2 permissions field and rejects accessor/prototype permissions without reading them', () => {
  expect(() =>
    readScoped({ ...scoped(), format: 'shared-project-scoped-v2' }),
  ).toThrow();
  let invoked = false;
  const permissions = Object.defineProperty({}, 'editMetadata', {
    enumerable: true,
    get() {
      invoked = true;
      return true;
    },
  });
  expect(() =>
    readScoped({
      ...scoped(),
      format: 'shared-project-scoped-v2',
      permissions,
    }),
  ).toThrow();
  expect(invoked).toBe(false);
  expect(() =>
    readScoped({
      ...scoped(),
      format: 'shared-project-scoped-v2',
      permissions: Object.assign(Object.create({ editMetadata: true }), {
        editMetadata: true,
      }),
    }),
  ).toThrow();
});

it.each([false, true])(
  'refuses permission injection into v1 and legacy formats (%s)',
  (editMetadata) => {
    for (const value of [scoped(), saved()])
      expect(() =>
        readScoped({ ...value, permissions: { editMetadata } }),
      ).toThrow('Shared projects unavailable');
  },
);

it('keeps a legacy view readable while old-chain assignments are unavailable', () => {
  const f = scopeFixture();
  f.document.plan = {
    ...DEFAULT_LAUNCH_PLAN,
    chain: 'Base',
    launchpad: 'Clanker',
    currency: 'ETH',
  };
  f.document.options.settings.pumpfun = {
    holderRewards: false,
    offchainCreation: false,
    feeSharing: false,
    feeShares: [],
  };
  const result = createScopedSharedProjectSnapshot(f.meta, f.document, null);
  expect(result.walletSelectionMatchesPlan).toBe(false);
  expect(result.walletScope).toEqual({
    mode: 'legacy',
    wallets: [],
    unavailableCount: 0,
  });
  expect(readScoped(result)).toEqual(result);
});

it('builds and admits a server-safe flat DTO exposing only the chosen public wallet reference', () => {
  const f = scopeFixture();
  const result = createScopedSharedProjectSnapshot(f.meta, f.document, f.scope);
  expect(result).toMatchObject({
    format: 'shared-project-scoped-v1',
    readOnly: true,
    walletScope: {
      mode: 'selected',
      wallets: f.scope.wallets,
      unavailableCount: 0,
    },
    assignedRecipients: 1,
    deployerAssigned: true,
    artworkSaved: true,
  });
  expect(readScoped(result)).toEqual(result);
  const text = JSON.stringify(result);
  for (const secret of [
    deployer,
    other,
    'private-folder',
    'example.invalid',
    'artworkUrl',
    'feeShares',
    'folderId',
    'identity',
    'options',
  ])
    expect(text).not.toContain(secret);
  expect(text).toContain(recipient);
  f.document.plan.tokenName = 'Changed input';
  f.scope.wallets[0].address = other;
  result.walletScope.wallets[0].revision = 9;
  expect(result.plan.tokenName).not.toBe('Changed input');
  expect(f.document.options.wallets.recipients[0].revision).toBe(1);
});

it('allows a deliberately empty scope without exposing any wallet address', () => {
  const f = scopeFixture();
  f.scope.wallets = [];
  const result = createScopedSharedProjectSnapshot(f.meta, f.document, f.scope);
  expect(result.walletScope).toEqual({
    mode: 'none',
    wallets: [],
    unavailableCount: 0,
  });
  for (const address of [recipient, deployer, other])
    expect(JSON.stringify(result)).not.toContain(address);
});

it('labels NULL scopes as legacy with all current assignments while still excluding private source fields', () => {
  const f = scopeFixture();
  const result = createScopedSharedProjectSnapshot(f.meta, f.document, null);
  expect(result.walletScope.mode).toBe('legacy');
  expect(result.walletScope.wallets.map((w) => w.address)).toEqual([
    deployer,
    recipient,
  ]);
  expect(result.walletScope.unavailableCount).toBe(0);
  expect(JSON.stringify(result)).not.toContain('private-folder');
  expect(JSON.stringify(result)).not.toContain(other);
  expect(readScoped(result)).toEqual(result);
});

it.each(['revision', 'role', 'removed', 'chain'] as const)(
  'does not expose a selected assignment after %s drift',
  (change) => {
    const f = scopeFixture();
    if (change === 'revision')
      f.document.options.wallets.recipients[0].revision++;
    if (change === 'role') {
      f.document.options.wallets = {
        chain: 'Solana',
        recipients: [],
        deployer: {
          address: recipient,
          revision: 1,
          folderRevision: 0,
          root: true,
        },
      };
    }
    if (change === 'removed') f.document.options.wallets.recipients = [];
    if (change === 'chain') f.scope.wallets[0].chain = 'Base';
    if (change === 'chain') {
      expect(() =>
        createScopedSharedProjectSnapshot(f.meta, f.document, f.scope),
      ).toThrow();
      return;
    }
    const result = createScopedSharedProjectSnapshot(
      f.meta,
      f.document,
      f.scope,
    );
    expect(result.walletScope).toEqual({
      mode: 'selected',
      wallets: [],
      unavailableCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain(recipient);
  },
);

it('does not include a newly assigned wallet or require unrelated project metadata to stay unchanged', () => {
  const f = scopeFixture();
  f.document.options.wallets.recipients.push({
    address: other,
    revision: 1,
    folderRevision: 0,
    root: true,
  });
  f.meta.updatedAt = '2026-10-25T09:00:00.000Z';
  const result = createScopedSharedProjectSnapshot(f.meta, f.document, f.scope);
  expect(result.assignedRecipients).toBe(2);
  expect(result.walletScope.wallets).toEqual(f.scope.wallets);
  expect(JSON.stringify(result)).not.toContain(other);
});

it.each([
  { format: 'shared-project-scoped-v2' },
  { readOnly: false },
  { readOnly: undefined },
  { id: '../project' },
  { shareId: 'invalid' },
  { archived: 1 },
  { updatedAt: 'yesterday' },
  { updatedAt: '2026-10-25T00:00:00Z' },
  { expiresAt: undefined },
  { expiresAt: false },
  { totalSupply: '0' },
  { totalSupply: '1.2' },
  { totalSupply: '1'.repeat(31) },
  { creatorTax: '1' },
  { creatorTax: NaN },
  { creatorTax: -1 },
  { creatorTax: 11 },
  { artworkSaved: 'yes' },
  { assignedRecipients: 201 },
  { assignedRecipients: '1' },
  { assignedRecipients: -1 },
  { deployerAssigned: 1 },
  { walletSelectionMatchesPlan: 'true' },
  { communityCoin: null },
  { buyback: 1 },
  { signingAllowed: true },
  { identity: { artworkUrl: 'https://secret.invalid' } },
  { options: { wallets: [other] } },
])('refuses malformed or expanded new DTO metadata %j', (change) => {
  expect(() => readScoped({ ...scoped(), ...change })).toThrow(
    'Shared projects unavailable',
  );
});

it.each([
  { mode: 'everything' },
  { mode: 'none' },
  { wallets: [] },
  { unavailableCount: -1 },
  { unavailableCount: '0' },
  { unavailableCount: 201 },
  { signingAllowed: true },
  { owner: 'private' },
])('refuses malformed wallet scope %j', (change) => {
  const value = scoped();
  expect(() =>
    readScoped({ ...value, walletScope: { ...value.walletScope, ...change } }),
  ).toThrow();
});

it('refuses wallet key expansion, duplicates, wrong chain, invalid addresses and incompatible counts', () => {
  const value = scoped();
  for (const wallet of [
    { ...value.walletScope.wallets[0], folderId: 'private' },
    { ...value.walletScope.wallets[0], revision: 0 },
    { ...value.walletScope.wallets[0], role: 'Owner' },
    { ...value.walletScope.wallets[0], address: 'invalid' },
    {
      ...value.walletScope.wallets[0],
      chain: 'Base',
      address: '0x' + '1'.repeat(40),
    },
  ])
    expect(() =>
      readScoped({
        ...value,
        walletScope: { ...value.walletScope, wallets: [wallet] },
      }),
    ).toThrow();
  expect(() =>
    readScoped({
      ...value,
      walletScope: {
        ...value.walletScope,
        wallets: [...value.walletScope.wallets, ...value.walletScope.wallets],
      },
    }),
  ).toThrow();
  expect(() => readScoped({ ...value, assignedRecipients: 0 })).toThrow();
  expect(() =>
    readScoped({
      ...value,
      walletScope: { mode: 'legacy', wallets: [], unavailableCount: 0 },
    }),
  ).toThrow();
});

it('refuses sparse/getter/prototype wallet arrays without evaluating accessors', () => {
  const value = scoped();
  const sparse = Array(1);
  let invoked = false;
  const accessor = [value.walletScope.wallets[0]];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() {
      invoked = true;
      return value.walletScope.wallets[0];
    },
  });
  const prototype = Object.assign(
    Object.create({ extra: true }),
    value.walletScope.wallets[0],
  );
  for (const wallets of [sparse, accessor, [prototype]])
    expect(() =>
      readScoped({ ...value, walletScope: { ...value.walletScope, wallets } }),
    ).toThrow();
  expect(invoked).toBe(false);
});

it.each([
  { creatorFeePercent: '0' },
  { creatorFeePercent: 1 },
  { creatorFeePercent: '1.00' },
  { feeShareLegCount: 11 },
  { feeShareLegCount: '1' },
  { feeSharing: false },
  { holderRewards: true },
  { holderRewards: 'false' },
  { privateAddress: other },
])('refuses malformed projected Pump settings %j', (change) => {
  const value = scoped();
  expect(() =>
    readScoped({
      ...value,
      pumpSettings: { ...value.pumpSettings, ...change },
    }),
  ).toThrow();
});

it('refuses unknown or coerced plan fields and nested flags without running getters', () => {
  const value = scoped();
  for (const plan of [
    { ...value.plan, developerBuy: '5' },
    { ...value.plan, unknownWallet: other },
    {
      ...value.plan,
      simulationSafety: {
        ...value.plan.simulationSafety,
        executionEnabled: true,
      },
    },
    {
      ...value.plan,
      simulationSafety: {
        ...value.plan.simulationSafety,
        maxScenarioExposure: '50',
      },
    },
    {
      ...value.plan,
      timing: { buyDelayMs: 0, initialBuyDelayMs: 0, privateAddress: other },
    },
  ])
    expect(() => readScoped({ ...value, plan })).toThrow();
  let invoked = false;
  Object.defineProperty(value.plan.simulationSafety, 'executionEnabled', {
    enumerable: true,
    get() {
      invoked = true;
      return false;
    },
  });
  expect(() => readScoped(value)).toThrow();
  expect(invoked).toBe(false);
});

it('admits detached scoped DTOs beside legacy server rows and refuses duplicate shares across formats', () => {
  const value = scoped();
  const legacy = saved();
  legacy.shareId = '22222222-2222-4222-8222-222222222222';
  const result = decodeSharedProjectSnapshots({ projects: [value, legacy] });
  expect(result).toHaveLength(2);
  value.walletScope.wallets[0].revision = 9;
  value.plan.simulationSafety.stopLossPercent = 9;
  expect(result[0].walletScope?.wallets[0].revision).toBe(1);
  expect(result[0].plan.simulationSafety.stopLossPercent).toBe(8);
  expect(() =>
    decodeSharedProjectSnapshots({ projects: [scoped(), saved()] }),
  ).toThrow();
});

it('requires the complete format-discriminated DTO instead of accepting missing scope fields', () => {
  for (const key of [
    'format',
    'walletScope',
    'pumpSettings',
    'expiresAt',
  ] as const) {
    const value = scoped() as Partial<ScopedSharedProjectSnapshot>;
    delete value[key];
    expect(() => readScoped(value)).toThrow();
  }
});

it('refuses metadata key expansion and accessor sources at the server builder boundary', () => {
  const f = scopeFixture();
  expect(() =>
    createScopedSharedProjectSnapshot(
      { ...f.meta, extra: true } as typeof f.meta,
      f.document,
      f.scope,
    ),
  ).toThrow();
  let invoked = false;
  Object.defineProperty(f.document.identity, 'website', {
    enumerable: true,
    get() {
      invoked = true;
      return 'https://private.invalid';
    },
  });
  expect(() =>
    createScopedSharedProjectSnapshot(f.meta, f.document, f.scope),
  ).toThrow();
  expect(invoked).toBe(false);
});
