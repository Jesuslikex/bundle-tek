import { afterEach, expect, it, vi } from 'vitest';
import { nativeWarmupFixture } from '@/test/warmup-native-fixture';
import { warmupV2AttemptProviderFixture } from '@/test/warmup-session-v2-attempt-provider-fixture';
import { unsignedPreparationSummary } from './imported-swap-preparation-history';
import {
  prepareWalletWarmupV2Attempt,
  readWalletWarmupV2Attempt,
} from './wallet-warmup-session-v2-attempts';
import { createWalletWarmupV2Provider } from './wallet-warmup-session-v2-provider';
import type { ImportedSwapSimulation } from './imported-swap-simulation';
import type {
  UnsignedSwapSummarySimulation,
  WarmupSessionSimulationObservation,
} from './unsigned-swap-summary-simulation';

afterEach(() => vi.unstubAllGlobals());

/** Test-only projection. It does not create or qualify runtime evidence. */
function summaryOnly(s: ImportedSwapSimulation): UnsignedSwapSummarySimulation {
  return {
    executionAllowed: s.executionAllowed,
    instructionsVerified: s.instructionsVerified,
    sha256: s.sha256,
    wallet: s.wallet,
    succeeded: s.succeeded,
    source: s.source,
    observedAt: s.observedAt,
    feeSlot: s.feeSlot,
    simulationSlot: s.simulationSlot,
    networkFeeLamports: s.networkFeeLamports,
    unitsConsumed: s.unitsConsumed,
    nativeChangeRaw: s.nativeChangeRaw,
    tokensComplete: s.tokensComplete,
    inputAmountMatches: s.inputAmountMatches,
    minimumOutputCovered: s.minimumOutputCovered,
    routeAssessment: { status: s.routeAssessment.status },
    accountBindings: { status: s.accountBindings.status },
    instructionReview: {
      authorityActionCount: s.instructionReview.authorityActionCount,
      unrecognizedInstructionCount:
        s.instructionReview.unrecognizedInstructionCount,
      unresolvedAccountCount: s.instructionReview.unresolvedAccountCount,
    },
  };
}

for (const options of [
  { side: 'Buy' as const },
  { side: 'Sell' as const },
  { side: 'Buy' as const, lookup: true },
  { side: 'Sell' as const, v2: true, token2022: true },
])
  it(`preserves the real-parser ${JSON.stringify(options)} history without legacy signing metadata`, async () => {
    const f = await nativeWarmupFixture(options),
      minimal = summaryOnly(f.simulation);
    expect(minimal).not.toHaveProperty('settlementEvidence');
    expect(minimal).not.toHaveProperty('lookupObservation');
    expect(minimal).not.toHaveProperty('token2022Evidence');
    expect(minimal.instructionReview).not.toHaveProperty('instructions');
    expect(unsignedPreparationSummary(f.order, minimal)).toEqual(
      unsignedPreparationSummary(f.order, f.simulation),
    );
    for (const key of [
      'routeAssessment',
      'accountBindings',
      'instructionReview',
    ] as const)
      delete minimal[key];
    expect(
      unsignedPreparationSummary(f.order, minimal).simulation,
    ).toMatchObject({
      routeStatus: 'Unavailable',
      bindingStatus: 'Unavailable',
      authorityActionCount: null,
      unrecognizedInstructionCount: null,
      unresolvedAccountCount: null,
    });
    for (const changed of [
      { sha256: '0'.repeat(64) },
      { wallet: f.mint },
      { executionAllowed: true },
      { instructionsVerified: true },
      { observedAt: 'invalid' },
      { nativeChangeRaw: '-0' },
      { succeeded: 'true' },
      { networkFeeLamports: (1n << 64n).toString() },
      { unitsConsumed: (1n << 64n).toString() },
    ])
      expect(() =>
        unsignedPreparationSummary(
          f.order,
          Object.assign({}, minimal, changed),
        ),
      ).toThrow();
  });

it.each([false, true])(
  'uses the narrow observation in the real v2 provider and immutable save/recovery path with one order and simulation (omit review details=%s)',
  async (omit) => {
    const f = await warmupV2AttemptProviderFixture();
    try {
      const fetcher = vi.fn(async (url: RequestInfo | URL) => {
        const parsed = new URL(url instanceof Request ? url.url : url);
        expect(parsed.origin + parsed.pathname).toBe(
          'https://api.jup.ag/swap/v2/order',
        );
        return Response.json(f.quote(parsed));
      });
      vi.stubGlobal('fetch', fetcher);
      const simulate = vi.fn(
        async (
          ...[order]: Parameters<typeof f.simulation>
        ): Promise<WarmupSessionSimulationObservation> => {
          const s = f.simulation(order);
          const observation = summaryOnly(s);
          if (omit)
            for (const key of [
              'routeAssessment',
              'accountBindings',
              'instructionReview',
            ] as const)
              delete observation[key];
          return { ...observation, tokenChanges: s.tokenChanges };
        },
      );
      const { previewRequested: _approval, ...input } = f.input(),
        signal = new AbortController().signal;
      const saved = await prepareWalletWarmupV2Attempt(
        f.db,
        'owner',
        input,
        true,
        signal,
        'synthetic-key',
        (db, owner, key, lease) =>
          createWalletWarmupV2Provider(db, owner, key, lease, { simulate }),
      );
      expect(saved.outcome?.kind).toBe('prepared');
      expect(saved.summary?.simulation.succeeded).toBe(true);
      expect(saved.summary?.executionAllowed).toBe(false);
      expect(saved.summary?.instructionsVerified).toBe(false);
      if (omit)
        expect(saved.summary?.simulation).toMatchObject({
          routeStatus: 'Unavailable',
          bindingStatus: 'Unavailable',
          authorityActionCount: null,
          unrecognizedInstructionCount: null,
          unresolvedAccountCount: null,
        });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(simulate).toHaveBeenCalledOnce();
      await f.control('stop');
      const recovered = await readWalletWarmupV2Attempt(
        f.db,
        'owner',
        input.id,
        signal,
      );
      expect(recovered?.lease).toEqual(saved.lease);
      expect(recovered?.outcome).toEqual(saved.outcome);
      expect(recovered?.summary).toEqual(saved.summary);
      expect(recovered?.journal.snapshot.phase).toBe('stopped');
      expect(fetcher).toHaveBeenCalledOnce();
      expect(simulate).toHaveBeenCalledOnce();
    } finally {
      f.client.close();
    }
  },
);
