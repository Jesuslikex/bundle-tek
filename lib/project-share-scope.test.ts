import bs58 from 'bs58';
import { expect, it, vi } from 'vitest';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  type ProjectDocument,
} from './workspace-project';
import {
  PROJECT_SHARE_SCOPE_MAX_WALLETS,
  readProjectShareScope,
  resolveProjectShareScope,
  shareAssignmentCandidates,
  type ProjectShareScope,
  type ProjectShareWallet,
} from './project-share-scope';

const revision = '2026-10-25T12:00:00.000Z';
const a = '11111111111111111111111111111111';
const b = 'SysvarRent111111111111111111111111111111111';
const c = 'SysvarC1ock11111111111111111111111111111111';
const wallet = (
  address = a,
  role: ProjectShareWallet['role'] = 'Recipient',
): ProjectShareWallet => ({
  chain: 'Solana',
  address,
  revision: 1,
  role,
});
const scope = (wallets = [wallet()]): ProjectShareScope => ({
  format: 'project-share-wallet-scope-v1',
  projectRevision: revision,
  wallets,
});
function document(): ProjectDocument {
  return {
    plan: structuredClone(DEFAULT_LAUNCH_PLAN),
    identity: structuredClone(EMPTY_IDENTITY),
    options: {
      ...structuredClone(DEFAULT_VENUE_OPTIONS),
      wallets: {
        chain: 'Solana',
        deployer: {
          address: b,
          revision: 2,
          folderId: 'private-folder',
          folderRevision: 8,
        },
        recipients: [
          { address: a, revision: 1, folderRevision: 0, root: true },
        ],
      },
    },
  };
}

it('admits an empty disclosure scope and returns a detached complete representation', () => {
  expect(readProjectShareScope(scope([]))).toEqual(scope([]));
  const input = scope();
  const parsed = readProjectShareScope(input);
  expect(parsed).toEqual(input);
  expect(parsed).not.toBe(input);
  expect(parsed.wallets).not.toBe(input.wallets);
  expect(parsed.wallets[0]).not.toBe(input.wallets[0]);
  parsed.wallets[0].revision = 7;
  expect(input.wallets[0].revision).toBe(1);
});

it.each([undefined, null, [], 'scope', false, new Date(), new Map()])(
  'refuses non-record scope %s',
  (value) => {
    expect(() => readProjectShareScope(value)).toThrow(
      'Project share scope is invalid.',
    );
  },
);

it.each([
  { ...scope(), format: 'viewer' },
  { ...scope(), projectRevision: '' },
  { ...scope(), projectRevision: '2026-10-25T12:00:00Z' },
  { ...scope(), projectRevision: '2026-02-30T12:00:00.000Z' },
  { ...scope(), projectRevision: '2026-10-25T13:00:00.000+01:00' },
  { ...scope(), projectRevision: null },
  { ...scope(), wallets: null },
  { ...scope(), futureWallets: true },
  { ...scope(), signingAllowed: true },
  { ...scope(), role: 'admin' },
])('refuses malformed or authority-bearing top-level terms %#', (value) => {
  expect(() => readProjectShareScope(value)).toThrow('scope is invalid');
});

it.each([
  { ...wallet(), chain: 'Unknown' },
  { ...wallet(), address: 'not-a-wallet' },
  { ...wallet(), address: ' ' + a },
  { ...wallet(), role: 'Funder' },
  { ...wallet(), role: 'Admin' },
  { ...wallet(), role: { toString: (): string => 'Recipient' } },
  { ...wallet(), revision: 0 },
  { ...wallet(), revision: -1 },
  { ...wallet(), revision: '1' },
  { ...wallet(), revision: 1.5 },
  { ...wallet(), revision: Number.MAX_SAFE_INTEGER },
  { ...wallet(), revision: Infinity },
  { ...wallet(), folderId: 'private-folder' },
  { ...wallet(), privateKey: 'secret' },
])('refuses malformed or extra wallet terms %#', (value) => {
  expect(() =>
    readProjectShareScope(scope([value as ProjectShareWallet])),
  ).toThrow('scope is invalid');
});

it('refuses an object role without coercing its custom conversion', () => {
  const conversion = vi.fn(() => 'Recipient');
  expect(() =>
    readProjectShareScope(
      scope([
        {
          ...wallet(),
          role: { toString: conversion },
        } as unknown as ProjectShareWallet,
      ]),
    ),
  ).toThrow();
  expect(conversion).not.toHaveBeenCalled();
});

it('requires canonical EVM addresses and preserves network identity separately', () => {
  const address = '0x52908400098527886E0F7030069857D2E4169EE7';
  const base: ProjectShareWallet = {
    chain: 'Base',
    address,
    revision: 3,
    role: 'Recipient',
  };
  expect(readProjectShareScope(scope([base])).wallets).toEqual([base]);
  expect(() =>
    readProjectShareScope(scope([{ ...base, address: address.toLowerCase() }])),
  ).toThrow();
  expect(
    readProjectShareScope(scope([base, { ...base, chain: 'Ethereum' }]))
      .wallets,
  ).toHaveLength(2);
});

it('refuses duplicate chain/address references even when revision or role differs', () => {
  for (const second of [
    wallet(),
    { ...wallet(), revision: 2 },
    wallet(a, 'Deployer'),
  ])
    expect(() => readProjectShareScope(scope([wallet(), second]))).toThrow();
});

it('admits the 201-reference bound and refuses the next entry', () => {
  const wallets = Array.from(
    { length: PROJECT_SHARE_SCOPE_MAX_WALLETS + 1 },
    (_, index) => {
      const bytes = new Uint8Array(32);
      bytes[0] = index;
      return wallet(bs58.encode(bytes));
    },
  );
  expect(
    readProjectShareScope(scope(wallets.slice(0, 201))).wallets,
  ).toHaveLength(201);
  expect(() => readProjectShareScope(scope(wallets))).toThrow();
});

it('refuses sparse arrays, custom array prototypes and custom properties', () => {
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = wallet();
  const prototype = [wallet()];
  Object.setPrototypeOf(prototype, Object.create(Array.prototype));
  const extra = Object.assign([wallet()], { authority: false });
  for (const wallets of [sparse, prototype, extra])
    expect(() => readProjectShareScope({ ...scope(), wallets })).toThrow();
});

it('refuses scope, wallet and list getters without invoking them', () => {
  const getter = vi.fn(() => wallet());
  const top = scope();
  Object.defineProperty(top, 'wallets', { enumerable: true, get: getter });
  const ref = wallet();
  Object.defineProperty(ref, 'address', { enumerable: true, get: getter });
  const array = [wallet()];
  Object.defineProperty(array, '0', { enumerable: true, get: getter });
  for (const value of [top, scope([ref]), { ...scope(), wallets: array }])
    expect(() => readProjectShareScope(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it('refuses symbols, hidden properties and inherited scope data, while admitting null-prototype records', () => {
  const symbol = Object.assign(scope(), { [Symbol('extra')]: true });
  const hidden = scope();
  Object.defineProperty(hidden, 'secret', { value: false, enumerable: false });
  const inherited = Object.assign(Object.create({ privilege: true }), scope());
  for (const value of [symbol, hidden, inherited])
    expect(() => readProjectShareScope(value)).toThrow();
  const safe = Object.assign(
    Object.create(null),
    scope([Object.assign(Object.create(null), wallet())]),
  );
  expect(readProjectShareScope(safe)).toEqual(scope());
});

it('builds candidates from exact saved roles and strips all folder metadata', () => {
  const source = document();
  const candidates = shareAssignmentCandidates(source);
  expect(candidates).toEqual([
    { chain: 'Solana', address: b, revision: 2, role: 'Deployer' },
    wallet(),
  ]);
  expect(JSON.stringify(candidates)).not.toContain('folder');
  expect(JSON.stringify(candidates)).not.toContain('root');
  candidates[0].revision = 8;
  expect(source.options.wallets!.deployer!.revision).toBe(2);
});

it('returns no candidates when assignments are absent or empty', () => {
  const source = document();
  delete source.options.wallets;
  expect(shareAssignmentCandidates(source)).toEqual([]);
  source.options.wallets = { chain: 'Base', recipients: [] };
  expect(shareAssignmentCandidates(source)).toEqual([]);
});

it('treats old-chain references as unavailable but refuses corrupt saved assignments', () => {
  const source = document();
  source.plan.chain = 'Base';
  expect(shareAssignmentCandidates(source)).toEqual([]);
  expect(resolveProjectShareScope(scope([wallet()]), source)).toEqual({
    wallets: [],
    unavailableCount: 1,
  });
  source.plan.chain = 'Solana';
  source.options.wallets!.recipients.push({
    address: a,
    revision: 3,
    folderRevision: 0,
  });
  expect(() => shareAssignmentCandidates(source)).toThrow('scope is invalid');
});

it('only resolves exact immutable role and revision references, in original scope order', () => {
  const source = document();
  const grant = scope([
    wallet(),
    { chain: 'Solana', address: b, revision: 2, role: 'Deployer' },
  ]);
  expect(resolveProjectShareScope(grant, source)).toEqual({
    wallets: grant.wallets,
    unavailableCount: 0,
  });
  source.options.wallets!.recipients[0].revision = 2;
  expect(resolveProjectShareScope(grant, source)).toEqual({
    wallets: [grant.wallets[1]],
    unavailableCount: 1,
  });
  source.options.wallets = {
    chain: 'Solana',
    recipients: [{ address: b, revision: 2, folderRevision: 0 }],
  };
  expect(resolveProjectShareScope(grant, source)).toEqual({
    wallets: [],
    unavailableCount: 2,
  });
});

it('never includes future assignments, even when the saved project gains new wallets', () => {
  const source = document();
  const grant = scope([wallet()]);
  source.options.wallets!.recipients.push({
    address: c,
    revision: 1,
    folderRevision: 0,
  });
  expect(resolveProjectShareScope(grant, source)).toEqual({
    wallets: [wallet()],
    unavailableCount: 0,
  });
  expect(resolveProjectShareScope(scope([]), source)).toEqual({
    wallets: [],
    unavailableCount: 0,
  });
  source.options.wallets!.recipients = [];
  expect(resolveProjectShareScope(grant, source)).toEqual({
    wallets: [],
    unavailableCount: 1,
  });
});

it('does not convert a same-address reference on another network into a current grant', () => {
  const address = '0x52908400098527886E0F7030069857D2E4169EE7';
  const source = document();
  source.plan.chain = 'Base';
  source.options.wallets = {
    chain: 'Base',
    recipients: [{ address, revision: 1, folderRevision: 0 }],
  };
  const grant = scope([
    { chain: 'Ethereum', address, revision: 1, role: 'Recipient' },
  ]);
  expect(resolveProjectShareScope(grant, source)).toEqual({
    wallets: [],
    unavailableCount: 1,
  });
});

it('resolves against current assignments without mutating the stored scope or source document', () => {
  const source = document();
  const grant = scope();
  const before = structuredClone({ source, grant });
  const result = resolveProjectShareScope(grant, source);
  result.wallets[0].revision = 99;
  expect({ source, grant }).toEqual(before);
  expect(() =>
    resolveProjectShareScope(
      { ...grant, executionAllowed: true } as ProjectShareScope,
      source,
    ),
  ).toThrow();
});
