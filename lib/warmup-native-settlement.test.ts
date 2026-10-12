import { it, expect } from 'vitest';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import {
  requireWarmupSigningReview,
  signApprovedWarmupPacket,
  type WarmupSigningReview,
} from './warmup-signing';
import { decodeWarmupReceipt } from './warmup-buy-receipt';
import { preparationHistoryFixture } from '../test/imported-preparation-history-fixture';
import type { SavedWarmupPreparation } from './warmup-preparation-history';
import type { VaultSession } from './browser-wallet-vault';
function saved(
  f: Awaited<ReturnType<typeof nativeWarmupFixture>>,
): SavedWarmupPreparation {
  return {
    id: crypto.randomUUID(),
    planId: 'qa',
    planRevision: 1,
    walletRevision: 1,
    cycle: 1,
    createdAt: new Date().toISOString(),
    document: {
      ...preparationHistoryFixture(),
      side: f.order.side,
      wallet: f.wallet,
      inputMint: f.order.inputMint,
      outputMint: f.order.outputMint,
      inAmountRaw: f.order.inAmount,
      quotedOutRaw: f.order.outAmount,
      minimumOutRaw: f.order.minimumOutAmount,
      expiresAt: f.order.expiresAt,
      inventory: null,
      transaction: {
        ...preparationHistoryFixture().transaction,
        sha256: f.order.preparation.sha256,
        bytes: f.order.preparation.transactionBytes,
      },
    },
  };
}
it.each([
  { side: 'Buy' as const },
  { side: 'Buy' as const, seed: true },
  { side: 'Buy' as const, seed: true, seedRentOnly: true },
  { side: 'Buy' as const, seed: true, initializer: 1 as const },
  { side: 'Sell' as const, seed: true, initializer: 16 as const },
  { side: 'Sell' as const },
  { side: 'Sell' as const, seed: true },
  { side: 'Buy' as const, existing: true },
  { side: 'Sell' as const, existing: true },
  { side: 'Buy' as const, lookup: true, shared: false, venue: 'RaydiumCP' },
  { side: 'Sell' as const, seed: true, lookup: true, venue: 'MeteoraDammV2' },
  { side: 'Buy' as const, keepWrapped: true },
  { side: 'Sell' as const, keepWrapped: true },
  { side: 'Buy' as const, v2: true, fee: 2, lookup: true, shared: false },
  { side: 'Sell' as const, v2: true, fee: 2, lookup: true },
])(
  'reviews exact wrapping, account rent and cleanup for %j, and verifies its signed final receipt',
  async (options) => {
    const f = await nativeWarmupFixture(options),
      settlement = await requireWarmupSigningReview(f.order, f.simulation);
    expect(settlement).toMatchObject({
      version: 1,
      wrappedFromNativeRaw:
        options.side === 'Buy' && !options.existing ? '1000000' : '0',
      closesWrappedAccount: !options.keepWrapped,
    });
    expect(BigInt(settlement.maximumNativeDebitLamports)).toBeLessThanOrEqual(
      5083560n,
    );
    expect(settlement.lookupTables.length).toBe(options.lookup ? 1 : 0);
    const prep = saved(f);
    const review: WarmupSigningReview = {
      id: crypto.randomUUID(),
      preparationId: prep.id,
      wallet: f.wallet,
      sha256: f.order.preparation.sha256,
      network: 'mainnet',
      expiresAt: f.order.expiresAt,
      transaction: f.order.preparation.transaction,
      lastValidBlockHeight: f.order.preparation.lastValidBlockHeight,
      maximumFeeLamports: '5000',
      inputRaw: f.order.inAmount,
      minimumOutputRaw: f.order.minimumOutAmount,
      inputMint: f.order.inputMint,
      outputMint: f.order.outputMint,
      settlement,
    };
    const session = {
      payload: {
        wallets: [
          { family: 'solana', address: f.wallet, seed: '07'.repeat(32) },
        ],
      },
    } as VaultSession;
    expect(await signApprovedWarmupPacket(session, review, () => {})).toEqual(
      f.signed,
    );
    const receipt = await decodeWarmupReceipt(
      f.receipt,
      prep,
      f.signed.signature,
      options.side,
    );
    expect(receipt.acquiredRaw).toBe('1000');
    expect(receipt.nativeSettlementRaw).toBe(
      options.side === 'Buy' ? '-1000000' : '1000000',
    );
  },
);
it('accepts a closed simulated system tombstone only when its native balance, bytes and token metadata show complete closure', async () => {
  const f = await nativeWarmupFixture({ v2: true, fee: 2 });
  f.simulation.settlementEvidence!.postAccounts![0] = {
    owner: '11111111111111111111111111111111',
    lamports: '0',
    executable: false,
    data: ['', 'base64'],
  };
  await expect(
    requireWarmupSigningReview(f.order, f.simulation),
  ).resolves.toMatchObject({ closesWrappedAccount: true });
  for (const change of [
    { lamports: '1' },
    { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    { executable: true },
    { data: ['AA==', 'base64'] },
  ]) {
    f.simulation.settlementEvidence!.postAccounts![0] = {
      owner: '11111111111111111111111111111111',
      lamports: '0',
      executable: false,
      data: ['', 'base64'],
      ...change,
    };
    await expect(
      requireWarmupSigningReview(f.order, f.simulation),
    ).rejects.toThrow();
  }
});
it('rejects redirects, bad setup order, extra transfers, incorrect wrap amounts, incomplete post-state and debit drift', async () => {
  const f = await nativeWarmupFixture();
  const edits: ((s: typeof f.simulation) => void)[] = [
    (s) => {
      s.tokensComplete = false;
    },
    (s) => {
      s.settlementEvidence = null;
    },
    (s) => {
      s.routeAssessment.status = 'Mismatch';
    },
    (s) => {
      s.networkFeeLamports = '1000001';
    },
    (s) => {
      s.settlementEvidence!.after[0] = String(
        BigInt(s.settlementEvidence!.after[0]) - 1n,
      );
    },
    (s) => {
      s.accountBindings.accounts[0].exists = true;
    },
    (s) => {
      s.settlementEvidence!.postAccounts![1] = {
        ...f.last[1],
        owner: '11111111111111111111111111111111',
      };
    },
    (s) => {
      s.instructionReview.instructions.find(
        (i) => i.action === 'Native SOL transfer',
      )!.dataHex = '0200000041420f0000000000';
    },
    (s) => {
      s.instructionReview.instructions.find(
        (i) => i.action === 'Wrapped SOL synchronization',
      )!.index = 99;
    },
    (s) => {
      s.instructionReview.instructions.find(
        (i) => i.action === 'Token account closure',
      )!.accounts[1].address = f.mint;
    },
    (s) => {
      s.instructionReview.instructions.find((i) =>
        i.program.address.startsWith('AToken'),
      )!.accounts[3].address = f.mint;
    },
    (s) => {
      s.instructionReview.instructions.push({
        ...s.instructionReview.instructions[0],
        index: 99,
      });
    },
    (s) => {
      s.instructionReview.instructions[0].program.writable = true;
    },
  ];
  for (const edit of edits) {
    const simulation = structuredClone(f.simulation);
    edit(simulation);
    await expect(
      requireWarmupSigningReview(f.order, simulation),
    ).rejects.toThrow();
  }
});
it('rejects a seed-address substitution and an uninitialized temporary account', async () => {
  const f = await nativeWarmupFixture({ seed: true });
  const seed = structuredClone(f.simulation);
  seed.instructionReview.instructions[0].dataHex =
    seed.instructionReview.instructions[0].dataHex.replace(
      '7761726d75702d74657374',
      '7861726d75702d74657374',
    );
  await expect(requireWarmupSigningReview(f.order, seed)).rejects.toThrow();
  const missing = structuredClone(f.simulation);
  missing.instructionReview.instructions.splice(1, 1);
  await expect(requireWarmupSigningReview(f.order, missing)).rejects.toThrow();
});
it('keeps returned existing wrapped units and rent out of the finalized sell minimum', async () => {
  const f = await nativeWarmupFixture({ side: 'Sell', existing: true }),
    prep = saved(f);
  f.receipt.meta.postBalances[0] = String(
    BigInt(f.receipt.meta.postBalances[0]) - 1000000n,
  );
  await expect(
    decodeWarmupReceipt(f.receipt, prep, f.signed.signature, 'Sell'),
  ).rejects.toThrow();
});
it('requires lookup observation and recheck rather than accepting an unresolved table count', async () => {
  const f = await nativeWarmupFixture({ lookup: true });
  for (const patch of [
    null,
    { ...f.simulation.lookupObservation!, recheckSlot: 100 },
    { ...f.simulation.lookupObservation!, tables: [] },
  ])
    await expect(
      requireWarmupSigningReview(f.order, {
        ...f.simulation,
        lookupObservation: patch,
      }),
    ).rejects.toThrow();
});
