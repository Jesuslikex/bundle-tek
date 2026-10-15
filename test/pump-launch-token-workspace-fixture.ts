import type { PumpGroupView } from '../lib/pump-launch-group-client';
import type { PumpLaunchTokenWorkspace } from '../lib/pump-launch-token-workspace';
import { importedTokenDocument } from '../lib/imported-token-project';
import { PUMP_TOKEN_2022 } from '../lib/pump-launch-config';
/** Presentation/codec fixture only. Real closure-to-import SQL is tested in the broadcast service suite. */
export function pumpTokenWorkspaceFixture(signed: PumpGroupView) {
  const group: PumpGroupView = {
    ...signed,
    state: 'finalized',
    receipt: {
      format: 'pump-launch-group-broadcast-terminal-v1',
      kind: 'finalized',
      reviewId: signed.review.id,
      contextSha256: signed.review.contextSha256,
      manifestSha256: signed.review.manifestSha256,
      signedGroupSha256: signed.signedEvidence!.signedGroupSha256,
      broadcastId: crypto.randomUUID(),
      broadcastSha256: 'a'.repeat(64),
      observationId: crypto.randomUUID(),
      observationSha256: 'b'.repeat(64),
      observedAt: new Date().toISOString(),
      sourceState: 'signed',
      groupNetworkFeeRaw: String(signed.review.packets.length * 5000),
      tipNetworkFeeRaw: '5000',
      knownNetworkFeeRaw: String((signed.review.packets.length + 1) * 5000),
      tipDebitRaw: '1000',
      networkFeeUnresolved: false,
      reservationsReleased: true,
      economicSettlementVerified: false,
      signingAllowed: false,
      executionAllowed: false,
      completeLaunch: false,
      atomicity: 'jito-transport-requested-not-proven',
    },
  };
  const mint = signed.review.input.create.mint,
    observedAt = new Date().toISOString();
  const result: PumpLaunchTokenWorkspace = {
    format: 'pump-launch-token-workspace-v1',
    reviewId: signed.review.id,
    contextSha256: signed.review.contextSha256,
    signedGroupSha256: signed.signedEvidence!.signedGroupSha256,
    mint,
    created: true,
    project: {
      id: crypto.randomUUID(),
      revision: 1,
      archived: false,
      updatedAt: observedAt,
      document: importedTokenDocument(
        { chain: 'Solana', address: mint },
        {
          chain: 'Solana',
          address: mint,
          name: signed.review.input.create.name,
          symbol: signed.review.input.create.symbol,
          decimals: 6,
          totalSupplyRaw: '1000000000000000',
          observedAt,
          metadataUri: signed.review.input.create.uri,
          source: 'https://controlled-fixture.example',
          contextSlot: 250,
          tokenProgram: PUMP_TOKEN_2022,
          metadataKind: 'Token-2022',
        },
      ),
    },
    signingAllowed: false,
    executionAllowed: false,
    reservationsChanged: false,
  };
  return { group, result };
}
