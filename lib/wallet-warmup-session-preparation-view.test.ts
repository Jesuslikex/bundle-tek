import { expect, it, vi } from 'vitest';
import { createWalletWarmupSessionProvider } from './wallet-warmup-session-provider';
import { prepareSolanaSwap } from './warmup-swap-quote';
import { warmupJournalClientFixture } from '@/test/warmup-session-journal-client-fixture';
import {
  warmupPreparationView as admit,
  type WarmupPreparationView,
} from './wallet-warmup-session-preparation-view';
import { warmupSessionProviderFixture } from '@/test/warmup-session-provider-fixture';
import { readWalletWarmupSessionConsent } from './wallet-warmup-session-consent';
import { warmupConsentSaved } from './wallet-warmup-session-consent-view';
import {
  warmupJournalContext,
  warmupJournalView,
} from './wallet-warmup-session-journal-view';
import { publicWalletWarmupSessionJournal } from './wallet-warmup-session-journal-public';
import { prepareWalletWarmupSessionAction } from './wallet-warmup-session-preparation';
import { publicWalletWarmupSessionPreparation } from './wallet-warmup-session-preparation-public';

async function fixture() {
  const at = Date.parse('2026-10-21T05:00:00.000Z');
  const f = await warmupJournalClientFixture(at);
  const journal = f.root();
  const a = f.context.actions[0];
  journal.version = 1;
  journal.snapshot.pending = {
    state: 'reviewing',
    action: {
      id: a.id,
      side: a.side,
      cycle: a.cycle,
      wallet: a.wallet,
      walletRevision: a.walletRevision,
      mint: a.mint,
      scheduledAt: a.scheduledAt,
    },
  };
  journal.recoveryRequired = true;
  journal.snapshot.phase = 'in-flight';
  const identity = {
    id: '00000000-0000-4000-8000-000000000004',
    journalId: journal.id,
    version: 1,
    headSha256: journal.headSha256,
  };
  const p: WarmupPreparationView = {
    id: identity.id,
    journalId: journal.id,
    actionId: a.id,
    reviewVersion: 1,
    reviewHeadSha256: journal.headSha256,
    planId: f.context.planId,
    planRevision: f.context.planRevision,
    cycle: a.cycle,
    walletRevision: a.walletRevision,
    createdAt: new Date(at + 40000).toISOString(),
    side: 'Buy',
    wallet: a.wallet,
    mint: a.mint,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: a.mint,
    inAmountRaw: String(a.inputLamports),
    quotedOutRaw: '101',
    minimumOutRaw: '100',
    expiresAt: new Date(at + 70000).toISOString(),
    packetAvailability: 'retained',
    packetSha256: 'b'.repeat(64),
    estimatedFeesLamports: '5000',
    nativeChangeRaw: '-1005000',
    limitations:
      'Unsigned preparation only. No signing, sending or automatic execution. Simulation and fee estimates do not establish instruction or custody clearance.',
    simulation: {
      succeeded: true,
      networkFeeLamports: '5000',
      tokensComplete: true,
      inputAmountMatches: null,
      minimumOutputCovered: true,
    },
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
    instructionsVerified: false,
  };
  const read = (value: unknown = { preparation: p }) =>
    admit(value, identity, journal, f.context);
  await warmupJournalView({ journal }, f.context);
  return { ...f, journal, identity, p, read };
}
it('admits an exact unsigned review and caps display freshness at the original source deadline', async () => {
  const f = await fixture();
  expect(f.read()).toEqual({
    ...f.p,
    effectiveReviewExpiresAt: f.context.sourceReviewExpiresAt,
  });
  expect(f.p.expiresAt > f.context.sourceReviewExpiresAt).toBe(true);
});
it('keeps historical recovery readable without extending either expiry', async () => {
  const f = await fixture();
  const original = structuredClone(f.journal);
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(f.context.sessionExpiresAt) + 60000);
  try {
    expect(f.read().effectiveReviewExpiresAt).toBe(
      f.context.sourceReviewExpiresAt,
    );
    expect(f.journal).toEqual(original);
  } finally {
    clock.mockRestore();
  }
});
for (const [field, value] of Object.entries({
  id: '00000000-0000-4000-8000-000000000009',
  journalId: '00000000-0000-4000-8000-000000000009',
  actionId: 'other',
  reviewVersion: 2,
  reviewHeadSha256: 'c'.repeat(64),
  planId: 'other',
  planRevision: 2,
  cycle: 2,
  walletRevision: 2,
  side: 'Sell',
  wallet: '11111111111111111111111111111111',
  mint: '11111111111111111111111111111111',
  inputMint: '11111111111111111111111111111111',
  outputMint: '11111111111111111111111111111111',
  inAmountRaw: '1000001',
  minimumOutRaw: '102',
  estimatedFeesLamports: '10000001',
  quotedOutRaw: '1000000',
  nativeChangeRaw: null,
  createdAt: '2026-10-21T05:01:00.000Z',
  expiresAt: '2026-10-21T05:00:00.000Z',
  packetSha256: null,
  executionAllowed: true,
  signingAllowed: true,
  automaticExecutionAllowed: true,
  instructionsVerified: true,
  transaction: 'private-bytes',
  limitations: 'verified safe to sign',
}))
  it(`refuses changed or extra ${field}`, async () => {
    const f = await fixture();
    expect(() => f.read({ preparation: { ...f.p, [field]: value } })).toThrow(
      'Recover the original request',
    );
  });
for (const [field, value] of Object.entries({
  succeeded: false,
  tokensComplete: false,
  inputAmountMatches: false,
  minimumOutputCovered: false,
  networkFeeLamports: '10000001',
  privateTrace: 'secret',
}))
  it(`refuses invalid simulation ${field}`, async () => {
    const f = await fixture();
    expect(() =>
      f.read({
        preparation: {
          ...f.p,
          simulation: { ...f.p.simulation, [field]: value },
        },
      }),
    ).toThrow();
  });
it('allows explicit packet absence only with a null packet hash', async () => {
  const f = await fixture();
  f.p.packetAvailability = 'summary-only';
  f.p.packetSha256 = null;
  expect(f.read().packetAvailability).toBe('summary-only');
  f.p.packetSha256 = 'b'.repeat(64);
  expect(() => f.read()).toThrow();
});
it('refuses a different original journal head and an unknown submitted action', async () => {
  const f = await fixture();
  f.identity.headSha256 = 'c'.repeat(64);
  expect(() => f.read()).toThrow();
  f.identity.headSha256 = f.journal.headSha256;
  f.journal.snapshot.pending!.state = 'unknown';
  expect(() => f.read()).toThrow();
});
it('never exposes raw parser errors or admits unexpected wrapper data', async () => {
  const f = await fixture();
  for (const value of [
    null,
    '<html>private error</html>',
    { preparation: f.p, raw: 'secret' },
    { preparation: { ...f.p, wallet: 'x'.repeat(17000) } },
  ])
    expect(() => f.read(value)).toThrow(
      'Saved unsigned preparation is unavailable',
    );
});
it('admits a Sell with wrapped-SOL output while requiring the exact saved-buy amount', async () => {
  const f = await fixture();
  const a = f.context.actions.find((item) => item.side === 'Sell')!;
  f.journal.snapshot.pending!.action = {
    id: a.id,
    side: a.side,
    cycle: a.cycle,
    wallet: a.wallet,
    walletRevision: a.walletRevision,
    mint: a.mint,
    scheduledAt: a.scheduledAt,
  };
  Object.assign(f.p, {
    actionId: a.id,
    side: 'Sell',
    inputMint: a.mint,
    outputMint: 'So11111111111111111111111111111111111111112',
    inAmountRaw: '100',
    createdAt: a.scheduledAt,
    expiresAt: new Date(Date.parse(a.scheduledAt) + 30000).toISOString(),
    simulation: {
      ...f.p.simulation,
      inputAmountMatches: true,
      minimumOutputCovered: null,
    },
  });
  expect(f.read().side).toBe('Sell');
  a.source = {
    kind: 'saved-buy',
    remainingRaw: '100',
    buyReceiptId: 'synthetic',
    decimals: 6,
  };
  expect(f.read().inAmountRaw).toBe('100');
  f.p.inAmountRaw = '101';
  expect(() => f.read()).toThrow();
  f.p.inAmountRaw = '99';
  expect(() => f.read()).toThrow('Recover the original request');
  f.p.inAmountRaw = '100';
  f.p.simulation.inputAmountMatches = null;
  expect(() => f.read()).toThrow();
});
it('refuses Buy overspend, impossible original paused heads and long quote lifetimes', async () => {
  const f = await fixture();
  f.journal.snapshot.wallets[0].recordedFurtherBuySpendLamports =
    f.context.wallets[0].buySpendLamports;
  expect(() => f.read()).toThrow('Recover the original request');
  f.journal.snapshot.wallets[0].recordedFurtherBuySpendLamports = '0';
  f.journal.snapshot.paused = true;
  expect(() => f.read()).toThrow('Recover the original request');
  f.journal.snapshot.paused = false;
  f.p.expiresAt = new Date(Date.parse(f.p.createdAt) + 30001).toISOString();
  expect(() => f.read()).toThrow('Recover the original request');
});
it('uses an earlier quote expiry without renewing the source deadline', async () => {
  const f = await fixture();
  f.p.expiresAt = new Date(Date.parse(f.p.createdAt) + 1000).toISOString();
  expect(f.read().effectiveReviewExpiresAt).toBe(f.p.expiresAt);
});
it('admits the actual SQL-retained preparation and server projections through the real consent and journal clients', async () => {
  const f = await warmupSessionProviderFixture();
  const clock = vi.spyOn(Date, 'now').mockImplementation(f.clock);
  try {
    const signal = new AbortController().signal;
    const saved = await readWalletWarmupSessionConsent(
      f.db,
      'owner',
      f.rootInput.consentId,
      signal,
    );
    if (!saved) throw Error('Missing fixture consent');
    const consent = await warmupConsentSaved(
      { consent: { ...saved, reviewCreatedAt: f.retainedReview.createdAt } },
      { id: saved.id, planId: f.plan.id },
    );
    const context = warmupJournalContext(consent);
    const journal = await warmupJournalView(
      { journal: publicWalletWarmupSessionJournal(f.journal) },
      context,
    );
    const identity = f.input();
    const retained = await prepareWalletWarmupSessionAction(
      f.db,
      'owner',
      {
        id: identity.id,
        journalId: identity.journalId,
        version: identity.version,
        headSha256: identity.headSha256,
      },
      signal,
      createWalletWarmupSessionProvider(f.db, 'owner', 'synthetic-key', {
        quote: (input, key, requestSignal) =>
          prepareSolanaSwap(input, key, requestSignal, async (url) =>
            Response.json(
              f.quote(
                new URL(
                  typeof url === 'string'
                    ? url
                    : url instanceof URL
                      ? url.href
                      : url.url,
                ),
              ),
            ),
          ),
        simulate: async (order) => f.simulation(order),
        now: f.clock,
      }),
      f.clock,
    );
    const result = admit(
      { preparation: publicWalletWarmupSessionPreparation(retained) },
      identity,
      journal,
      context,
    );
    expect(result.packetAvailability).toBe('retained');
    expect(result.signingAllowed).toBe(false);
    expect(result.actionId).toBe(journal.snapshot.pending?.action.id);
  } finally {
    clock.mockRestore();
    f.client.close();
  }
});
