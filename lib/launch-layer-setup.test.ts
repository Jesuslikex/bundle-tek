import { expect, it } from 'vitest';
import { layerNativeFixture } from '../test/launch-layer-native-fixture';
import {
  createLaunchLayerSetup,
  parseLaunchLayerSetup,
} from './launch-layer-setup';

async function fixture(stock = false) {
  const { f, plan } = await layerNativeFixture(stock);
  const binding = {
    projectId: f.selection.projectId,
    projectUpdatedAt: f.updatedAt,
    snapshotSha256: 'a'.repeat(64),
  };
  const setup = createLaunchLayerSetup(f.document, plan.envelope, binding);
  return { f, envelope: plan.envelope, binding, setup };
}
it('projects only original saved identity and venue choices, detached and without authority', async () => {
  const { f, envelope, binding } = await fixture();
  f.document.identity.artworkUrl = '/api/artwork/' + '1'.repeat(64);
  f.document.identity.website = 'https://example.test/original';
  f.document.options.settings.pumpfun.feeSharing = true;
  f.document.options.settings.pumpfun.feeShares = [
    { address: f.address(1), shareBps: 3333 },
    { address: f.address(2), shareBps: 6667 },
  ];
  const setup = createLaunchLayerSetup(f.document, envelope, binding);
  f.document.identity.website = 'https://example.test/changed';
  f.document.options.settings.pumpfun.feeShares[0].shareBps = 1;
  expect(setup.identity.website).toBe('https://example.test/original');
  expect(setup.pumpfun!.feeShares[0].shareBps).toBe(3333);
  expect(parseLaunchLayerSetup(setup, envelope, binding)).toEqual(setup);
  expect(setup).toMatchObject({
    planningOnly: true,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(Object.keys(setup.identity).sort()).toEqual([
    'artworkUrl',
    'telegram',
    'twitter',
    'website',
  ]);
});
it.each([
  'project',
  'revision',
  'terms',
  'snapshot',
  'authority',
  'url',
  'fee-total',
  'fee-key',
  'extra',
  'pump-null',
  'creator-format',
  'creator-ineligible',
  'duplicate-recipient',
  'shares-off',
  'rewards-conflict',
  'artwork-path',
] as const)('refuses a changed or malformed %s projection', async (kind) => {
  const { f, setup, envelope, binding } = await fixture();
  const value = structuredClone(setup);
  if (kind === 'pump-null') value.pumpfun = null;
  if (kind === 'creator-format') value.pumpfun!.creatorFeePercent = '1.50';
  if (kind === 'creator-ineligible') value.pumpfun!.creatorFeePercent = '1.5';
  if (kind === 'duplicate-recipient') {
    value.pumpfun!.feeSharing = true;
    value.pumpfun!.feeShares = [
      { address: f.address(1), shareBps: 5000 },
      { address: f.address(1), shareBps: 5000 },
    ];
  }
  if (kind === 'shares-off')
    value.pumpfun!.feeShares = [{ address: f.address(1), shareBps: 10000 }];
  if (kind === 'rewards-conflict') {
    value.pumpfun!.holderRewards = true;
    value.pumpfun!.feeSharing = true;
    value.pumpfun!.feeShares = [{ address: f.address(1), shareBps: 10000 }];
  }
  if (kind === 'artwork-path') value.identity.artworkUrl = '/api/artwork/xyz';
  if (kind === 'project') value.projectId = 'another-project';
  if (kind === 'revision') value.projectUpdatedAt = '2026-10-18T04:00:00.000Z';
  if (kind === 'terms') value.termsSha256 = 'b'.repeat(64);
  if (kind === 'snapshot') value.snapshotSha256 = 'b'.repeat(64);
  if (kind === 'authority') Object.assign(value, { signingAllowed: true });
  if (kind === 'url') value.identity.website = 'javascript:alert(1)';
  if (kind === 'fee-total') {
    value.pumpfun!.feeSharing = true;
    value.pumpfun!.feeShares = [{ address: f.address(1), shareBps: 9999 }];
  }
  if (kind === 'fee-key') {
    value.pumpfun!.feeSharing = true;
    value.pumpfun!.feeShares = [
      { address: 'not-a-real-public-key'.padEnd(32, '0'), shareBps: 10000 },
    ];
  }
  if (kind === 'extra')
    Object.assign(value, { rawSourceDocument: 'not public' });
  expect(() => parseLaunchLayerSetup(value, envelope, binding)).toThrow();
});
it('keeps StonkFun outside Pump settings and distinguishes a draft from a saved snapshot', async () => {
  const { f, envelope, binding, setup } = await fixture(true);
  expect(setup.pumpfun).toBeNull();
  expect(() =>
    parseLaunchLayerSetup(
      {
        ...setup,
        pumpfun: {
          holderRewards: false,
          offchainCreation: false,
          feeSharing: false,
          creatorFeePercent: null,
          feeShares: [],
        },
      },
      envelope,
      binding,
    ),
  ).toThrow();
  const draft = createLaunchLayerSetup(f.document, envelope, {
    ...binding,
    snapshotSha256: null,
  });
  expect(() => parseLaunchLayerSetup(draft, envelope, binding)).toThrow();
});
it('checks the envelope revision even when the outer binding and projection agree', async () => {
  const { setup, envelope, binding } = await fixture();
  const fake = '2026-10-18T04:00:00.000Z';
  expect(() =>
    parseLaunchLayerSetup({ ...setup, projectUpdatedAt: fake }, envelope, {
      ...binding,
      projectUpdatedAt: fake,
    }),
  ).toThrow();
});
it('refuses to project a newer plan under old term bindings', async () => {
  const { f, envelope, binding } = await fixture();
  f.document.plan.ticker = 'NEW';
  expect(() => createLaunchLayerSetup(f.document, envelope, binding)).toThrow(
    /source differs/,
  );
  expect(() =>
    createLaunchLayerSetup(f.document, envelope, {
      ...binding,
      projectUpdatedAt: '2026-10-18T04:00:00.000Z',
    }),
  ).toThrow();
});
