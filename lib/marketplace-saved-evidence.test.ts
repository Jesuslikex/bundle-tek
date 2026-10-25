import { expect, it } from 'vitest';
import { marketplaceOwnedFixture } from '../test/marketplace-owned-fixture';
import {
  buildMarketplaceOwnedInventory,
  admitMarketplaceOwnedInventory,
} from './marketplace-owned-inventory';
import {
  admitSavedEvidencePage,
  savedEvidenceRequest,
  savedEvidenceUrl,
  savedEvidenceCursor,
  savedWalletCursor,
  savedHistoryCursor,
  savedEvidenceAuthority,
  readSavedEvidencePage,
  type SavedEvidenceRequest,
  type SavedHistoryPage,
  type SavedWalletPage,
} from './marketplace-saved-evidence';
const now = Date.parse('2026-10-24T19:00:00.000Z'),
  f = marketplaceOwnedFixture(now);
const inventory = buildMarketplaceOwnedInventory(f.sources, now);
const w = inventory.wallets[0];
const wallet = {
  address: w.address,
  label: w.label,
  revision: w.revision,
  updatedAt: w.updatedAt,
};
const walletRequest: Extract<SavedEvidenceRequest, { view: 'wallets' }> = {
  view: 'wallets',
  cursor: null,
};
const historyRequest: Extract<SavedEvidenceRequest, { view: 'history' }> = {
  view: 'history',
  address: w.address,
  revision: w.revision,
  cursor: null,
};
function wallets(): SavedWalletPage {
  return {
    format: 'marketplace-saved-evidence-page-v1',
    chain: 'Solana',
    view: 'wallets',
    request: { ...walletRequest },
    observedAt: new Date(now).toISOString(),
    nextCursor: null,
    wallets: [{ ...wallet }],
    ...savedEvidenceAuthority,
  };
}
function history(): SavedHistoryPage {
  const r = f.sources.runs[0] as {
    id: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
  };
  return {
    format: 'marketplace-saved-evidence-page-v1',
    chain: 'Solana',
    view: 'history',
    request: { ...historyRequest },
    observedAt: new Date(now).toISOString(),
    nextCursor: null,
    wallet: { ...wallet },
    records: [
      {
        ...r,
        observation: w.latestHistory,
        capturedWalletRevision: 2,
        outcome: 'observation',
      },
    ].map(
      ({
        id,
        revision,
        createdAt,
        updatedAt,
        observation,
        capturedWalletRevision,
      }) => ({
        id,
        revision,
        createdAt,
        updatedAt,
        observation,
        capturedWalletRevision,
        outcome: 'observation',
      }),
    ),
    ...savedEvidenceAuthority,
  };
}
it('keeps selected saved observations separate from complete inventory, wallet age or control proof', () => {
  const result = admitSavedEvidencePage(history(), historyRequest, now);
  expect(result).toMatchObject({
    completeInventory: false,
    completeHistory: false,
    controlProven: false,
    lifecycleVerified: false,
    listingAllowed: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(() => admitMarketplaceOwnedInventory(result, now)).toThrow();
  expect(result).not.toHaveProperty('observedActivityAgeSeconds');
});
it('preserves historical capture revisions without treating revision equality as lifecycle proof', () => {
  const page = history();
  page.wallet.revision = 3;
  page.request = { ...historyRequest, revision: 3 };
  expect(admitSavedEvidencePage(page, page.request, now)).toMatchObject({
    lifecycleVerified: false,
    records: [{ capturedWalletRevision: 2 }],
  });
  page.records[0].capturedWalletRevision = 4;
  expect(() => admitSavedEvidencePage(page, page.request, now)).toThrow();
});
it('canonical request URLs accept reordered caller properties but bind all scope fields', () => {
  for (const request of [walletRequest, historyRequest]) {
    const url = savedEvidenceUrl(request);
    expect(
      savedEvidenceRequest(new URL(url, 'https://bundle.test').searchParams),
    ).toEqual(request);
  }
  const reordered = {
    cursor: null,
    revision: w.revision,
    address: w.address,
    view: 'history' as const,
  };
  expect(savedEvidenceUrl(reordered)).toBe(savedEvidenceUrl(historyRequest));
});
it.each([
  'view=bad',
  'view=wallets&owner=other',
  'view=wallets&cursor=',
  'view=wallets&view=wallets',
  'view=history',
  'view=history&address=bad&revision=1',
])('rejects malformed/extra query fields %s', (query) =>
  expect(() => savedEvidenceRequest(new URLSearchParams(query))).toThrow(),
);
it('rejects changed cursor scope, noncanonical timestamps/JSON and noninteger revision', () => {
  const url = new URL(savedEvidenceUrl(historyRequest), 'https://bundle.test');
  for (const cursor of [
    savedWalletCursor(w.address),
    savedHistoryCursor({ address: f.b, revision: 2 }, f.date(600000), f.runId),
    savedHistoryCursor(
      { address: w.address, revision: 3 },
      f.date(600000),
      f.runId,
    ),
    JSON.stringify([1, 'history', w.address, 2, '2026-10-24', f.runId]),
    ' ' + savedHistoryCursor(historyRequest, f.date(600000), f.runId),
  ]) {
    url.searchParams.set('cursor', cursor);
    expect(() => savedEvidenceRequest(url.searchParams)).toThrow();
  }
  url.searchParams.delete('cursor');
  url.searchParams.set('revision', '02');
  expect(() => savedEvidenceRequest(url.searchParams)).toThrow();
});
it('uses a last-returned keyset reference without making it an ownership token', () => {
  const cursor = savedHistoryCursor(historyRequest, f.date(600000), f.runId);
  expect(savedEvidenceCursor({ ...historyRequest, cursor })).toEqual({
    createdAt: f.date(600000),
    id: f.runId,
  });
  const page = wallets();
  page.nextCursor = savedWalletCursor(w.address);
  expect(admitSavedEvidencePage(page, walletRequest, now).nextCursor).toBe(
    page.nextCursor,
  );
});
it.each([
  'completeInventory',
  'completeHistory',
  'controlProven',
  'lifecycleVerified',
  'listingAllowed',
  'paymentAllowed',
  'deliveryAllowed',
  'signingAllowed',
  'executionAllowed',
])('refuses authority/completeness field %s', (field) =>
  expect(() =>
    admitSavedEvidencePage(
      { ...history(), [field]: true },
      historyRequest,
      now,
    ),
  ).toThrow(),
);
it.each([
  { rawDocument: 'PRIVATE' },
  { error: 'SECRET' },
  { chain: 'Base' },
  { format: 'bundle-owned-wallet-inventory-v1' },
  { observedAt: '2026-10-24T20:00:00.000Z' },
])(
  'refuses raw, foreign, stale or incorrectly formatted response %#',
  (change) =>
    expect(() =>
      admitSavedEvidencePage({ ...history(), ...change }, historyRequest, now),
    ).toThrow(),
);
it('binds exact request/cursor and rejects duplicate, reordered or overlong wallet pages', () => {
  const page = wallets();
  expect(() =>
    admitSavedEvidencePage(
      {
        ...page,
        request: { ...walletRequest, cursor: savedWalletCursor(w.address) },
      },
      walletRequest,
      now,
    ),
  ).toThrow();
  expect(() =>
    admitSavedEvidencePage(
      { ...page, wallets: [wallet, wallet] },
      walletRequest,
      now,
    ),
  ).toThrow();
  expect(() =>
    admitSavedEvidencePage(
      { ...page, wallets: Array(21).fill(wallet) },
      walletRequest,
      now,
    ),
  ).toThrow();
  expect(() =>
    admitSavedEvidencePage(
      { ...page, nextCursor: savedWalletCursor(f.b) },
      walletRequest,
      now,
    ),
  ).toThrow();
  expect(() =>
    admitSavedEvidencePage(
      { ...page, wallets: [], nextCursor: savedWalletCursor(w.address) },
      walletRequest,
      now,
    ),
  ).toThrow();
});
it('requires descending history keys and exact next cursor, with no automatic skipping', () => {
  const page = history(),
    first = page.records[0];
  expect(() =>
    admitSavedEvidencePage(
      { ...page, records: [first, first] },
      historyRequest,
      now,
    ),
  ).toThrow();
  expect(() =>
    admitSavedEvidencePage(
      {
        ...page,
        nextCursor: savedHistoryCursor(
          historyRequest,
          first.createdAt,
          'different',
        ),
      },
      historyRequest,
      now,
    ),
  ).toThrow();
  const next = savedHistoryCursor(historyRequest, first.createdAt, first.id);
  expect(() =>
    admitSavedEvidencePage(
      { ...page, request: { ...historyRequest, cursor: next } },
      { ...historyRequest, cursor: next },
      now,
    ),
  ).toThrow();
});
it('distinguishes failed and not-yet-recorded reads without exposing error text or invented zero balances', () => {
  for (const outcome of ['read-failed', 'not-recorded'] as const) {
    const page = history();
    page.records[0].outcome = outcome;
    page.records[0].observation = null;
    expect(admitSavedEvidencePage(page, historyRequest, now)).toMatchObject({
      records: [{ outcome, observation: null }],
    });
  }
  const page = history();
  page.records[0].observation = null;
  expect(() => admitSavedEvidencePage(page, historyRequest, now)).toThrow();
});
it('rejects mismatched source revision/run, inconsistent sample dates and invalid counts', () => {
  for (const change of [
    { runId: 'wrong' },
    { walletRevision: 3 },
    { sampleCount: 0 },
    { successfulSampleCount: 51 },
    { oldestSampledActivityAt: null },
    { latestSampledActivityAt: '2026-10-24T21:00:00.000Z' },
  ]) {
    const page = history();
    page.records[0].observation = {
      ...page.records[0].observation!,
      ...change,
    };
    expect(() => admitSavedEvidencePage(page, historyRequest, now)).toThrow();
  }
});
it('cancels error bodies without echoing HTML or private response text', async () => {
  const c = new AbortController();
  await expect(
    readSavedEvidencePage(
      new Response('<html>SECRET</html>', { status: 401 }),
      historyRequest,
      c.signal,
    ),
  ).rejects.toThrow('Sign in');
  await expect(
    readSavedEvidencePage(
      new Response('<html>SECRET</html>'),
      historyRequest,
      c.signal,
    ),
  ).rejects.toThrow('Saved wallet evidence is unavailable');
  c.abort();
  await expect(
    readSavedEvidencePage(Response.json(history()), historyRequest, c.signal),
  ).rejects.toBeDefined();
});
it('owns cancellation while a JSON body is pending', async () => {
  const c = new AbortController();
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  const pending = readSavedEvidencePage(response, historyRequest, c.signal);
  c.abort();
  await expect(pending).rejects.toBeDefined();
  expect(cancelled).toBe(true);
});

it('roundtrips printable legacy record IDs without treating a cursor as a permission', () => {
  for (const id of [
    'legacy id',
    '/import+01',
    '_old',
    '-old',
    '.old',
    'quote"slash\\',
  ]) {
    const cursor = savedHistoryCursor(historyRequest, f.date(600000), id);
    const parsed = savedEvidenceRequest(
      new URL(
        savedEvidenceUrl({ ...historyRequest, cursor }),
        'https://bundle.test',
      ).searchParams,
    );
    expect(savedEvidenceCursor(parsed)).toEqual({
      createdAt: f.date(600000),
      id,
    });
  }
});
it('classifies stale/future page time as a fixed display-clock issue', () => {
  expect(() =>
    admitSavedEvidencePage(wallets(), walletRequest, now + 300001),
  ).toThrow('Check automatic date and time');
  expect(() =>
    admitSavedEvidencePage(wallets(), walletRequest, now - 5001),
  ).toThrow('Check automatic date and time');
});
