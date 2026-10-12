import { observeSignaturePage, signatureCursor } from './tracked-signatures';
import { observeTrackedTransaction } from './tracked-wallet-transaction';
import type { SupplyHistoryRow } from './supply-history';
import { observeSupplyTokenAccounts } from './supply-token-accounts';
import {
  classifyWalletMovement,
  type WalletMovementClassification,
} from './wallet-movement-classification';
export type SupplyMovementEvidence = {
  observationId: string;
  wallet: string;
  indexedAddress?: string;
  accountObservedSlot?: number;
  mint: string;
  fromSlot: number;
  toSlot: number;
  anchor: number;
  requestedCursor: string | null;
  nextCursor: string | null;
  scannedSignatures: number;
  failedSignatures: number;
  unavailableTransactions: number;
  completeThroughBoundary: boolean;
  transactions: {
    signature: string;
    slot: number;
    blockTime: number | null;
    beforeRaw: string;
    afterRaw: string;
    changeRaw: string;
    decimals: number;
    source: string;
    classification?: WalletMovementClassification;
  }[];
  observedAt: string;
};
export function supplyMovementInterval(
  current: SupplyHistoryRow,
  previous: SupplyHistoryRow,
  wallet: string,
) {
  if (
    current.scopeId !== previous.scopeId ||
    current.document.previousSequence !== previous.sequence ||
    current.document.snapshot.mint !== previous.document.snapshot.mint ||
    !current.document.alerts.some((a) => a.address === wallet)
  )
    throw new Error('Choose a saved wallet alert.');
  const now = current.document.snapshot.wallets.find(
      (w) => w.address === wallet,
    ),
    before = previous.document.snapshot.wallets.find(
      (w) => w.address === wallet,
    );
  if (
    !now ||
    !before ||
    before.slot >= now.slot ||
    now.group !== before.group ||
    current.document.snapshot.decimals !== previous.document.snapshot.decimals
  )
    throw new Error('Wallet observation interval differs.');
  return {
    mint: current.document.snapshot.mint,
    decimals: current.document.snapshot.decimals,
    fromSlot: before.slot,
    toSlot: now.slot,
  };
}
export async function observeSupplyMovementEvidence(
  current: SupplyHistoryRow,
  previous: SupplyHistoryRow,
  wallet: string,
  cursor: string | null,
  signal: AbortSignal,
  indexedAddress = wallet,
) {
  const interval = supplyMovementInterval(current, previous, wallet);
  const parsedCursor = signatureCursor(cursor);
  let accountObservedSlot: number | undefined;
  if (indexedAddress !== wallet) {
    const accounts = await observeSupplyTokenAccounts(
      wallet,
      interval.mint,
      interval.decimals,
      interval.toSlot,
      signal,
    );
    if (!accounts.accounts.includes(indexedAddress))
      throw new Error(
        'Selected token account is not currently owned by this wallet for this mint.',
      );
    accountObservedSlot = accounts.slot;
  }
  const page = await observeSignaturePage(
    indexedAddress,
    'mainnet',
    parsedCursor,
    signal,
  );
  if (
    page.address !== indexedAddress ||
    page.network !== 'mainnet' ||
    page.anchor < interval.toSlot
  )
    throw new Error(
      'Interval is not yet covered by a finalized provider anchor.',
    );
  const evidence: SupplyMovementEvidence = {
    observationId: current.id,
    wallet,
    indexedAddress,
    ...(accountObservedSlot !== undefined ? { accountObservedSlot } : {}),
    mint: interval.mint,
    fromSlot: interval.fromSlot,
    toSlot: interval.toSlot,
    anchor: page.anchor,
    requestedCursor: cursor,
    nextCursor: page.nextCursor,
    scannedSignatures: 0,
    failedSignatures: 0,
    unavailableTransactions: 0,
    completeThroughBoundary: false,
    transactions: [],
    observedAt: new Date().toISOString(),
  };
  let fetched = 0;
  for (const item of page.signatures) {
    if (item.slot <= interval.fromSlot) {
      evidence.completeThroughBoundary = true;
      evidence.nextCursor = null;
      break;
    }
    if (item.slot > interval.toSlot) {
      evidence.scannedSignatures++;
      continue;
    }
    if (!item.failed && fetched >= 5) {
      break;
    }
    evidence.scannedSignatures++;
    evidence.nextCursor = JSON.stringify({
      signature: item.signature,
      slot: item.slot,
      anchor: page.anchor,
    });
    if (item.failed) {
      evidence.failedSignatures++;
      continue;
    }
    fetched++;
    const tx = await observeTrackedTransaction(
      wallet,
      'mainnet',
      item.signature,
      signal,
    );
    if (!tx) {
      evidence.unavailableTransactions++;
      continue;
    }
    if (
      tx.signature !== item.signature ||
      tx.address !== wallet ||
      tx.network !== 'mainnet' ||
      tx.slot !== item.slot ||
      tx.failed
    )
      throw new Error('Transaction differs from finalized signature evidence.');
    if (!tx.tokensComplete) {
      evidence.unavailableTransactions++;
      continue;
    }
    const changes = tx.tokenChanges.filter((t) => t.mint === interval.mint);
    if (
      changes.length > 1 ||
      changes.some((t) => t.decimals !== interval.decimals)
    )
      throw new Error('Transaction token precision differs.');
    const token = changes[0];
    if (
      token &&
      indexedAddress !== wallet &&
      !token.accounts.includes(indexedAddress)
    )
      throw new Error(
        'Decoded token change does not include the selected token account.',
      );
    if (token && BigInt(token.changeRaw) !== 0n)
      evidence.transactions.push({
        signature: tx.signature,
        slot: tx.slot,
        blockTime: tx.blockTime,
        beforeRaw: token.beforeRaw,
        afterRaw: token.afterRaw,
        changeRaw: token.changeRaw,
        decimals: token.decimals,
        source: tx.source,
        classification: classifyWalletMovement(tx, interval.mint),
      });
  }
  if (
    evidence.scannedSignatures === page.signatures.length &&
    !page.nextCursor
  ) {
    evidence.completeThroughBoundary = true;
    evidence.nextCursor = null;
  }
  return evidence;
}
