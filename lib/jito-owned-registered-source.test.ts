import { afterEach, expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { jitoDatabase } from '../test/jito-sqlite';
import {
  beginJitoSignAttempt,
  registerJitoSignAttempt,
} from './jito-sign-attempt-server';
import {
  captureOwnedRegisteredJitoSource,
  recheckOwnedRegisteredJitoSource,
} from './jito-owned-registered-source';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  saved: vi.fn(),
  session: vi.fn(),
  order: vi.fn(),
}));
vi.mock('./imported-swap-approval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./imported-swap-approval')>()),
  currentImportedPreparation: mocks.saved,
}));
vi.mock('./imported-trade-session-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./imported-trade-session-server')>()),
  currentTradeSession: mocks.session,
}));
vi.mock('./warmup-signing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./warmup-signing')>()),
  restoreSavedSwapOrder: mocks.order,
}));
const dbs: ReturnType<typeof jitoDatabase>[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.sqlite.close();
  vi.clearAllMocks();
});
async function setup(complete = true) {
  const f = await jitoBundleFixture(),
    d = jitoDatabase(f.manifest, true, true);
  dbs.push(d);
  d.sqlite.exec(
    "ALTER TABLE imported_token_projects ADD COLUMN document TEXT; UPDATE imported_token_projects SET document='{}'",
  );
  d.attach();
  const m = f.manifest,
    review = m.swaps[0],
    id = m.id,
    hash = m.sha256;
  mocks.saved.mockResolvedValue({
    id: review.preparationId,
    projectId: m.projectId,
    projectRevision: 1,
    walletRevision: 1,
    createdAt: m.createdAt,
    document: JSON.stringify({ session: review.session }),
  });
  mocks.session.mockResolvedValue({
    selection: review.session,
    document: 'stable',
    controlRevision: 1,
  });
  mocks.order.mockResolvedValue({
    preparation: {
      wallet: review.wallet,
      lastValidBlockHeight: review.lastValidBlockHeight,
    },
    inputMint: review.inputMint,
    outputMint: review.outputMint,
    inAmount: review.inputRaw,
    minimumOutAmount: review.minimumOutputRaw,
    expiresAt: review.expiresAt,
  });
  const swap = crypto.randomUUID();
  await beginJitoSignAttempt(d.db, 'owner', id, hash, 0, swap);
  if (complete) {
    await registerJitoSignAttempt(
      d.db,
      'owner',
      id,
      hash,
      0,
      swap,
      f.swap.signed.transaction,
    );
    const tip = crypto.randomUUID();
    await beginJitoSignAttempt(d.db, 'owner', id, hash, 1, tip);
    await registerJitoSignAttempt(
      d.db,
      'owner',
      id,
      hash,
      1,
      tip,
      f.tip.signed.transaction,
    );
  }
  return { f, d, m, id, hash };
}
it('retains an opaque process-local source and compares a repeat read without authority', async () => {
  const { f, d, id, hash } = await setup();
  const fetcher = vi.spyOn(globalThis, 'fetch');
  try {
    const h = await captureOwnedRegisteredJitoSource(d.db, 'owner', id, hash);
    expect(JSON.stringify(h)).not.toContain(f.swap.signed.transaction);
    expect(await recheckOwnedRegisteredJitoSource(h)).toEqual({
      matched: true,
      sourceCurrent: false,
      providerQualified: false,
      signingAllowed: false,
      executionAllowed: false,
    });
    await expect(recheckOwnedRegisteredJitoSource({ ...h })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});
it('rejects a wrong owner or digest and an UNKNOWN packet', async () => {
  const { d, id, hash } = await setup(false);
  await expect(
    captureOwnedRegisteredJitoSource(d.db, 'owner', id, hash),
  ).rejects.toThrow();
  await expect(
    captureOwnedRegisteredJitoSource(d.db, 'other', id, hash),
  ).rejects.toThrow();
  await expect(
    captureOwnedRegisteredJitoSource(d.db, 'owner', id, 'ab'.repeat(32)),
  ).rejects.toThrow();
});
it('refuses a changed session or reservation on recheck', async () => {
  const { d, id, hash } = await setup();
  const h = await captureOwnedRegisteredJitoSource(d.db, 'owner', id, hash);
  mocks.session.mockResolvedValueOnce({
    document: 'changed',
    controlRevision: 2,
  });
  await expect(recheckOwnedRegisteredJitoSource(h)).rejects.toThrow();
  d.sqlite.exec(
    "DELETE FROM solana_execution_reservations WHERE owner_id='owner'",
  );
  await expect(recheckOwnedRegisteredJitoSource(h)).rejects.toThrow();
});
it('refuses state changes between the first and second reads', async () => {
  const { d, id, hash } = await setup();
  mocks.session
    .mockResolvedValueOnce({ document: 'first', controlRevision: 1 })
    .mockResolvedValueOnce({ document: 'second', controlRevision: 2 });
  await expect(
    captureOwnedRegisteredJitoSource(d.db, 'owner', id, hash),
  ).rejects.toThrow();
});
it('does not expose underlying reader errors or signed packets', async () => {
  const { d, id, hash, f } = await setup();
  mocks.saved.mockRejectedValueOnce(new Error(f.swap.signed.transaction));
  await expect(
    captureOwnedRegisteredJitoSource(d.db, 'owner', id, hash),
  ).rejects.toThrow('Owned registered Jito source unavailable.');
});
it('rejects a saved acquisition or platform fee that differs from the review', async () => {
  const { d, id, hash, m } = await setup();
  mocks.saved.mockResolvedValueOnce({
    id: m.swaps[0].preparationId,
    projectId: m.projectId,
    document: JSON.stringify({
      session: m.swaps[0].session,
      acquisition: { unexpected: true },
    }),
  });
  await expect(
    captureOwnedRegisteredJitoSource(d.db, 'owner', id, hash),
  ).rejects.toThrow();
  mocks.order.mockResolvedValueOnce({
    preparation: {
      wallet: m.swaps[0].wallet,
      lastValidBlockHeight: m.swaps[0].lastValidBlockHeight,
    },
    inputMint: m.swaps[0].inputMint,
    outputMint: m.swaps[0].outputMint,
    inAmount: m.swaps[0].inputRaw,
    minimumOutAmount: m.swaps[0].minimumOutputRaw,
    expiresAt: m.swaps[0].expiresAt,
    platformFee: { bps: 1, mint: m.swaps[0].inputMint },
  });
  await expect(
    captureOwnedRegisteredJitoSource(d.db, 'owner', id, hash),
  ).rejects.toThrow();
});
it('hashes each bounded canonical database read without publishing its packets', async () => {
  const { d, id, hash, f } = await setup();
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let matchingReads = 0;
  const spy = vi
    .spyOn(crypto.subtle, 'digest')
    .mockImplementation(async (algorithm, bytes) => {
      const text = new TextDecoder().decode(bytes as BufferSource);
      if (text.includes(f.swap.signed.transaction)) matchingReads++;
      return original(algorithm, bytes);
    });
  try {
    const h = await captureOwnedRegisteredJitoSource(d.db, 'owner', id, hash);
    expect(matchingReads).toBe(2);
    await recheckOwnedRegisteredJitoSource(h);
    expect(matchingReads).toBe(3);
    expect(JSON.stringify(h)).not.toContain(f.swap.signed.transaction);
  } finally {
    spy.mockRestore();
  }
});
it('refuses an oversized source snapshot and does not expose packet bytes', async () => {
  const { d, id, hash, f } = await setup();
  mocks.session.mockResolvedValue({
    document: 'x'.repeat(8 * 1024 * 1024 + 1),
    controlRevision: 1,
  });
  const pending = captureOwnedRegisteredJitoSource(d.db, 'owner', id, hash);
  await expect(pending).rejects.toThrow(
    'Owned registered Jito source unavailable.',
  );
  await pending.catch((error: Error) => {
    expect(error.message).not.toContain(f.swap.signed.transaction);
  });
});
it.each([
  'digest',
  'signer',
  'nonce',
  'intent',
  'transaction',
  'signature',
] as const)('refuses a substituted receipt %s', async (field) => {
  const { d, id, hash } = await setup();
  d.sqlite.exec('DROP TRIGGER jito_receipt_update');
  const column = {
    digest: 'manifest_sha256',
    signer: 'signer',
    nonce: 'attempt_id',
    intent: 'intent_id',
    transaction: '`transaction`',
    signature: 'signature',
  }[field];
  d.sqlite
    .prepare(
      `UPDATE jito_sign_receipts SET ${column}=? WHERE owner_id=? AND bundle_id=? AND packet=0`,
    )
    .run('substituted', 'owner', id);
  await expect(
    captureOwnedRegisteredJitoSource(d.db, 'owner', id, hash),
  ).rejects.toThrow();
});
it('refuses legacy protocol absence and an archived project', async () => {
  const { d, id, hash } = await setup();
  d.sqlite.exec('DROP TRIGGER jito_protocol_delete');
  d.sqlite
    .prepare(
      'DELETE FROM jito_bundle_protocol WHERE owner_id=? AND bundle_id=?',
    )
    .run('owner', id);
  await expect(
    captureOwnedRegisteredJitoSource(d.db, 'owner', id, hash),
  ).rejects.toThrow();
  const newer = await setup();
  newer.d.sqlite
    .prepare(
      'UPDATE imported_token_projects SET archived=1 WHERE owner_id=? AND id=?',
    )
    .run('owner', newer.m.projectId);
  await expect(
    captureOwnedRegisteredJitoSource(newer.d.db, 'owner', newer.id, newer.hash),
  ).rejects.toThrow();
});
