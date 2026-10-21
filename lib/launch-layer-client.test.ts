import { expect, it } from 'vitest';
import { layerUiFixture } from '../test/launch-layer-ui-fixture';
import {
  initialLayerDraft,
  layerSelectionRequest,
  savedLayerMatchesSelection,
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
import {
  saveOwnedLaunchLayerPlan,
  readLaunchLayerContext,
} from './launch-layer-service';
it('binds saved setup to the retained result and refuses draft substitution', async () => {
  const f = layerUiFixture(),
    storage = await layerTestStorage(f);
  try {
    const saved = await saveOwnedLaunchLayerPlan(storage.db, 'alice', {
      ...f.selection,
      layers: f.layers,
    });
    expect(parseSavedLayer(saved, f.selection.projectId).setup).toEqual(
      saved.setup,
    );
    expect(() =>
      parseSavedLayer(
        { ...saved, setup: { ...saved.setup, snapshotSha256: null } },
        f.selection.projectId,
      ),
    ).toThrow(/could not be confirmed/);
    expect(() =>
      parseSavedLayer({ ...saved, setup: null }, f.selection.projectId),
    ).toThrow(/could not be confirmed/);
    expect(() =>
      parseSavedLayer(
        { ...saved, setup: { ...saved.setup, pumpfun: null } },
        f.selection.projectId,
      ),
    ).toThrow(/could not be confirmed/);
    const fake = '2026-10-18T04:00:00.000Z';
    expect(() =>
      parseSavedLayer(
        {
          ...saved,
          projectUpdatedAt: fake,
          setup: { ...saved.setup, projectUpdatedAt: fake },
        },
        f.selection.projectId,
      ),
    ).toThrow(/could not be confirmed/);
    expect(
      parseSavedLayer({ ...saved, setup: undefined }, f.selection.projectId)
        .setup,
    ).toBeUndefined();
  } finally {
    storage.client.close();
  }
});
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

it('binds imported context and saved ceilings to the exact owned ID, revision and mint through real storage', async () => {
  const f = layerUiFixture();
  f.document.plan.scheduled = true;
  const selection = {
    ...f.selection,
    target: {
      kind: 'imported' as const,
      projectId: 'imported-target',
      revision: 3,
      mint: f.address(90),
    },
  };
  const storage = await layerTestStorage(f);
  try {
    await storage.db
      .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,?,?)')
      .bind(
        'alice',
        'imported-target',
        'Solana',
        selection.target.mint,
        JSON.stringify({
          token: { chain: 'Solana', address: selection.target.mint },
        }),
        3,
        0,
      )
      .run();
    const request = layerSelectionRequest(selection);
    expect(request.target).toEqual({
      kind: 'imported',
      projectId: 'imported-target',
      revision: 3,
    });
    expect(request.target).not.toHaveProperty('mint');
    const raw = await readLaunchLayerContext(storage.db, 'alice', request);
    const context = parseLayerContext(raw, selection);
    expect(context.importedTarget).toEqual({
      projectId: 'imported-target',
      revision: 3,
    });
    for (const altered of [
      { ...raw, importedTarget: undefined },
      { ...raw, importedTarget: { projectId: 'another-target', revision: 3 } },
      { ...raw, importedTarget: { projectId: 'imported-target', revision: 4 } },
      { ...raw, target: { kind: 'new', mint: selection.target.mint } },
      { ...raw, target: { kind: 'imported', mint: f.address(91) } },
      { ...raw, signingAllowed: true },
    ])
      expect(() => parseLayerContext(altered, selection)).toThrow();
    const noDeployer = structuredClone(context);
    delete noDeployer.document.options.wallets!.deployer;
    expect(
      initialLayerDraft(noDeployer).rows.some(
        (row) => row.role === 'developer',
      ),
    ).toBe(false);
    const unscheduled = structuredClone(context);
    unscheduled.document.plan.scheduled = false;
    expect(() => initialLayerDraft(unscheduled)).toThrow('scheduled');
    const draft = {
      ...f.draft,
      rows: f.draft.rows.filter((row) => row.role !== 'developer'),
    };
    expect(layerRequest(draft, context).roles.developer).toBeUndefined();
    expect(() => layerRequest(f.draft, context)).toThrow('no developer');
    const envelope = await reviewLayerDraft(draft, context);
    const stored = await saveOwnedLaunchLayerPlan(storage.db, 'alice', {
      ...request,
      layers: layerRequest(draft, context),
    });
    const saved = parseSavedLayer(stored, selection.projectId);
    expect(saved.importedTarget).toEqual({
      projectId: 'imported-target',
      revision: 3,
    });
    expect(savedLayerMatchesSelection(saved, selection)).toBe(true);
    expect(
      savedLayerMatchesSelection(saved, {
        ...selection,
        target: { ...selection.target, projectId: 'another-target' },
      }),
    ).toBe(false);
    expect(
      savedLayerMatchesSelection(saved, {
        ...selection,
        target: { ...selection.target, revision: 4 },
      }),
    ).toBe(false);
    await expect(reopenLayerDraft(envelope, context)).rejects.toThrow(
      'different',
    );
    await expect(
      reopenLayerDraft(envelope, context, {
        projectId: 'another-target',
        revision: 3,
      }),
    ).rejects.toThrow('different');
    const reopened = await reopenLayerDraft(
      envelope,
      context,
      saved.importedTarget,
    );
    expect(layerRequest(reopened, context)).toEqual(
      layerRequest(draft, context),
    );
    await storage.db
      .prepare('UPDATE imported_token_projects SET revision=4')
      .run();
    await expect(
      readLaunchLayerContext(storage.db, 'alice', request),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      saveOwnedLaunchLayerPlan(storage.db, 'alice', {
        ...request,
        layers: layerRequest(draft, context),
      }),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    storage.client.close();
  }
});
