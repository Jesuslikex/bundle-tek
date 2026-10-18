import { expect, it } from 'vitest';
import { layerUiFixture } from '../test/launch-layer-ui-fixture';
import {
  initialLayerDraft,
  layerAmount,
  layerDisplay,
  layerRequest,
  parseLayerContext,
  parseSavedLayer,
  reviewLayerDraft,
  reopenLayerDraft,
} from './launch-layer-client';
import { quoteCatalog } from './quote-catalog';
import { layerTestStorage } from '../test/launch-layer-storage';
import { saveOwnedLaunchLayerPlan } from './launch-layer-service';

it('retains a Front-only editor request through actual storage', async () => {
  const f = layerUiFixture();
  const storage = await layerTestStorage(f);
  try {
    f.draft.rows = f.draft.rows.filter(
      (r) => r.role !== 'back' && r.role !== 'temporary',
    );
    f.draft.frontToBackDelayMs = '0';
    f.draft.backToTemporaryDelayMs = '0';
    const saved = await saveOwnedLaunchLayerPlan(storage.db, 'alice', {
      ...f.selection,
      layers: layerRequest(f.draft, f.context),
    });
    expect(saved.current).toBe(true);
  } finally {
    storage.client.close();
  }
});
it('reopens exact saved ceilings with new row identities and refuses changed source or mint', async () => {
  const f = layerUiFixture(),
    envelope = await reviewLayerDraft(f.draft, f.context);
  const reopened = await reopenLayerDraft(envelope, f.context);
  expect(layerRequest(reopened, f.context)).toEqual(f.layers);
  expect(reopened.rows[0].id).not.toBe(f.draft.rows[0].id);
  f.context.target.mint = f.address(98);
  await expect(reopenLayerDraft(envelope, f.context)).rejects.toThrow(
    /different/,
  );
});

it('binds loaded context to the exact source and public mint with all authority disabled', () => {
  const f = layerUiFixture();
  expect(parseLayerContext(f.context, f.selection)).toEqual(f.context);
  for (const patch of [
    { projectId: 'other' },
    { projectUpdatedAt: '2026-10-17T00:00:00.000Z' },
    { target: { kind: 'new', mint: f.address(98) } },
    { signingAllowed: true },
    { executionAllowed: true },
  ])
    expect(() =>
      parseLayerContext({ ...f.context, ...patch }, f.selection),
    ).toThrow();
});
it('locks saved developer and ordered holders without inventing budget defaults', () => {
  const f = layerUiFixture(),
    draft = initialLayerDraft(f.context);
  expect(draft.rows.map((r) => r.role)).toEqual([
    'funder',
    'developer',
    'front',
    'holders',
    'holders',
  ]);
  expect(draft.rows[1].wallet).toEqual(f.layers.roles.developer!.wallet);
  expect(draft.rows.slice(3).map((r) => r.wallet)).toEqual(
    f.layers.roles.holders.map((m) => m.wallet),
  );
  expect(
    draft.rows.every((r) => r.fee === '' && r.rent === '' && r.reserve === ''),
  ).toBe(true);
  expect(() => layerRequest(draft, f.context)).toThrow();
  f.context.document.options.wallets = undefined;
  expect(() => initialLayerDraft(f.context)).toThrow(/developer/);
});
it('converts display values exactly and refuses exponent, negative, rounding and overflow inputs', () => {
  expect(layerAmount('9007199254.740993', 6)).toBe('9007199254740993');
  expect(layerAmount('18446744073.709551615', 9)).toBe('18446744073709551615');
  expect(layerDisplay('9007199254740993', 6)).toBe('9007199254.740993');
  for (const value of [
    '1e-9',
    '-1',
    ' 1',
    '00',
    '',
    '0.0000000001',
    '18446744073.709551616',
  ])
    expect(() => layerAmount(value, 9)).toThrow();
});
it('preserves every role ceiling and the distinct delay units through review', async () => {
  const f = layerUiFixture();
  expect(layerRequest(f.draft, f.context)).toEqual(f.layers);
  const envelope = await reviewLayerDraft(f.draft, f.context);
  expect(envelope.terms.totals.maximumNativeBudgetLamports).toBe('14736400');
  expect(envelope.terms.delays).toEqual(f.layers.delays);
  expect(envelope.terms.signingAllowed).toBe(false);
});
it('refuses duplicate roles, stale references, missing buyers and invalid delay units', async () => {
  const f = layerUiFixture();
  f.draft.rows.find((r) => r.role === 'front')!.wallet = f.draft.rows[0].wallet;
  await expect(reviewLayerDraft(f.draft, f.context)).rejects.toThrow(/unique/);
  const stale = layerUiFixture();
  stale.draft.rows[0].wallet!.revision++;
  await expect(reviewLayerDraft(stale.draft, stale.context)).rejects.toThrow(
    /Reselect/,
  );
  const invalid = layerUiFixture();
  invalid.draft.frontToBackDelayMs = '0.5';
  expect(() => layerRequest(invalid.draft, invalid.context)).toThrow(
    /whole delay/,
  );
  const noBuy = layerUiFixture();
  noBuy.draft.rows.find((r) => r.role === 'front')!.buy = '0';
  await expect(reviewLayerDraft(noBuy.draft, noBuy.context)).rejects.toThrow(
    /positive/,
  );
});
it('keeps stock quote principal separate from native ceilings without enabling stock signing', async () => {
  const f = layerUiFixture();
  const asset = quoteCatalog('Solana', 'StonkFun').assets.find(
    (a) => a.symbol === 'TSLAX',
  )!;
  Object.assign(f.context.document.plan, {
    launchpad: 'StonkFun',
    currency: asset.symbol,
    quoteAddress: asset.address,
  });
  f.draft.rows = f.draft.rows.filter(
    (r) => r.role !== 'back' && r.role !== 'temporary',
  );
  f.draft.frontToBackDelayMs = '0';
  f.draft.backToTemporaryDelayMs = '0';
  f.draft.rows.find((r) => r.role === 'front')!.buy = layerDisplay(
    '9007199254740993',
    asset.decimals,
  );
  const envelope = await reviewLayerDraft(f.draft, f.context);
  expect(envelope.terms.quote.kind).toBe('token');
  expect(envelope.terms.totals.maximumNativeBudgetLamports).toBe('10525000');
  expect(envelope.terms.signingAllowed).toBe(false);
});
it('refuses saved plans with foreign ownership scope, missing authority flags or an enabled gate', async () => {
  const f = layerUiFixture(),
    envelope = await reviewLayerDraft(f.draft, f.context);
  const saved = {
    id: crypto.randomUUID(),
    projectId: f.selection.projectId,
    projectUpdatedAt: f.updatedAt,
    createdAt: f.updatedAt,
    sha256: 'a'.repeat(64),
    current: false,
    planningOnly: true,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
    envelope,
  };
  expect(parseSavedLayer(saved, f.selection.projectId).current).toBe(false);
  expect(() => parseSavedLayer(saved, 'foreign')).toThrow();
  expect(() =>
    parseSavedLayer(
      { ...saved, signingAllowed: undefined },
      f.selection.projectId,
    ),
  ).toThrow();
  expect(() =>
    parseSavedLayer(
      {
        ...saved,
        envelope: {
          ...envelope,
          terms: { ...envelope.terms, executionAllowed: true },
        },
      },
      f.selection.projectId,
    ),
  ).toThrow();
});
