import { it, expect } from 'vitest';
import { pairRuntimeFixture } from '../test/pair-runtime-fixture';
import { inspectOwnedImportedPairOrder } from './imported-pair-order-candidate';
import { collectPairRuntimePreview } from './pair-runtime-preview';
import type {
  SolanaSwapRuntimeContext,
  SolanaSwapRuntimeAsset,
} from './solana-swap-runtime-context';
it('uses real owned evidence without imported-project metadata in the lower runtime input', async () => {
  const f = await pairRuntimeFixture();
  try {
    const signal = new AbortController().signal;
    const result = await inspectOwnedImportedPairOrder(
      f.db,
      'alice',
      f.orderRequest,
      signal,
      f.runtimeDependencies,
      async (preflight, order, rpc, now) => {
        const asset = (a: SolanaSwapRuntimeAsset) => ({
          address: a.address,
          program: a.program,
          decimals: a.decimals,
          amountPolicy: structuredClone(a.amountPolicy),
          extensions: [...a.extensions],
          issuerControls: [...a.issuerControls],
        });
        const { quote, evidence } = preflight;
        const context: SolanaSwapRuntimeContext = {
          wallet: preflight.wallet,
          contextSha256: preflight.contextSha256,
          expiresAt: preflight.expiresAt,
          quote: {
            side: quote.side,
            inputRaw: quote.inputRaw,
            pair: {
              base: asset(quote.pair.base),
              quote: asset(quote.pair.quote),
              mintPolicy: structuredClone(quote.pair.mintPolicy),
              sha256: quote.pair.sha256,
            },
            quote: {
              minimumOutAmount: quote.quote.minimumOutAmount,
              ...(quote.quote.platformFee
                ? { platformFee: quote.quote.platformFee }
                : {}),
            },
          },
          evidence: {
            slot: evidence.slot,
            unixTimestamp: evidence.unixTimestamp,
            nativeBalanceRaw: evidence.nativeBalanceRaw,
            systemRentMinimumRaw: evidence.systemRentMinimumRaw,
            accounts: structuredClone(evidence.accounts),
          },
          funding: {
            userFeeAndRentLimitRaw: preflight.funding.userFeeAndRentLimitRaw,
          },
        };
        expect(context.quote.pair).not.toHaveProperty('projectId');
        expect(context.quote.pair).not.toHaveProperty('catalogSnapshot');
        expect(context).not.toHaveProperty('format');
        const before = structuredClone(context);
        const runtime = await collectPairRuntimePreview(
          { preflight: context, order },
          rpc,
          f.runtimeDependencies.programRpc!,
          signal,
          now,
        );
        expect(context).toEqual(before);
        expect(runtime.runtime).toMatchObject({
          codeIdentityObserved: true,
          signingAllowed: false,
          executionAllowed: false,
          trustedProgramPolicyEstablished: false,
        });
        expect(
          runtime.runtime.maximumSlot - runtime.runtime.minimumSlot,
        ).toBeLessThanOrEqual(32);
        expect(runtime.codeScans).toHaveLength(2);
        expect(runtime.codeScans[0]).toEqual(runtime.codeScans[1]);
        return runtime;
      },
    );
    expect(result.signingAllowed).toBe(false);
    expect(result.executionAllowed).toBe(false);
  } finally {
    f.close();
  }
});
