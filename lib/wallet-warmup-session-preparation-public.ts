import type { readWalletWarmupSessionPreparation } from './wallet-warmup-session-preparation';
type Retained = NonNullable<
  Awaited<ReturnType<typeof readWalletWarmupSessionPreparation>>
>;
/** Raw packet, internal records and source/proof documents never cross this boundary. */
export function publicWalletWarmupSessionPreparation(value: Retained) {
  const p = value.preparation,
    d = p.document;
  return {
    id: p.id,
    journalId: value.identity.journal_id,
    actionId: value.identity.action_id,
    reviewVersion: value.identity.review_version,
    reviewHeadSha256: value.identity.review_sha256,
    planId: p.planId,
    planRevision: p.planRevision,
    cycle: p.cycle,
    walletRevision: p.walletRevision,
    createdAt: p.createdAt,
    side: d.side,
    wallet: d.wallet,
    mint: d.side === 'Buy' ? d.outputMint : d.inputMint,
    inputMint: d.inputMint,
    outputMint: d.outputMint,
    inAmountRaw: d.inAmountRaw,
    quotedOutRaw: d.quotedOutRaw,
    minimumOutRaw: d.minimumOutRaw,
    expiresAt: d.expiresAt,
    packetAvailability: value.packetAvailability,
    packetSha256: value.packet?.sha256 ?? null,
    estimatedFeesLamports: d.transaction.estimatedFeesLamports,
    simulation: {
      succeeded: d.simulation.succeeded,
      networkFeeLamports: d.simulation.networkFeeLamports,
      tokensComplete: d.simulation.tokensComplete,
      inputAmountMatches: d.simulation.inputAmountMatches,
      minimumOutputCovered: d.simulation.minimumOutputCovered,
    },
    executionAllowed: false as const,
    signingAllowed: false as const,
    automaticExecutionAllowed: false as const,
    instructionsVerified: false as const,
  };
}
