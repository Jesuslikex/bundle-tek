import { warmupJournalClientFixture } from './warmup-session-journal-client-fixture';
import {
  warmupJournalView,
  type WarmupJournalView,
} from '../lib/wallet-warmup-session-journal-view';
/** Synthetic public unsigned display data only. No real wallet/provider/SQL. */
export async function warmupPreparationClientFixture(at = Date.now()) {
  const f = await warmupJournalClientFixture(at),
    root = f.root();
  const command = { ...f.request(root), control: 'begin-review' as const };
  const journal = await warmupJournalView(
    { journal: await f.apply(root, command, at) },
    f.context,
    { request: command, requireReceipt: true, previous: root },
  );
  function preparation(id: string, review: WarmupJournalView = journal) {
    const a = review.snapshot.pending!.action;
    return {
      preparation: {
        id,
        journalId: review.id,
        actionId: a.id,
        reviewVersion: review.version,
        reviewHeadSha256: review.headSha256,
        planId: f.context.planId,
        planRevision: f.context.planRevision,
        cycle: a.cycle,
        walletRevision: a.walletRevision,
        createdAt: new Date(at + 1000).toISOString(),
        side: 'Buy' as const,
        wallet: a.wallet,
        mint: a.mint,
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: a.mint,
        inAmountRaw: String(f.context.actions[0].inputLamports),
        quotedOutRaw: '101',
        minimumOutRaw: '100',
        expiresAt: new Date(at + 30000).toISOString(),
        packetAvailability: 'retained' as const,
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
      },
    };
  }
  function recovery(id: string, original = journal, current = journal) {
    return {
      recovery: {
        readOnly: true,
        preparation: preparation(id, original).preparation,
        originalJournal: { ...original, commandReceipt: null },
        currentJournal: { ...current, commandReceipt: null },
      },
    };
  }
  return { ...f, root, journal, command, preparation, recovery };
}
