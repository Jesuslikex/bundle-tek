import { expect, it } from 'vitest';
import {
  decodeSharedProjectSnapshots,
  readSharedProjectSnapshots,
} from './shared-project-review';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import { EMPTY_IDENTITY, DEFAULT_VENUE_OPTIONS } from './workspace-project';
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
