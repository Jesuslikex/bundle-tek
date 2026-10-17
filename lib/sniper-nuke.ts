import bs58 from 'bs58';
import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { verifySolanaSignature } from './solana-signature';
import type { VaultSession } from './browser-wallet-vault';
import {
  requireApprovedWarmupPacket,
  signApprovedWarmupPacket,
  type WarmupSigningReview,
} from './warmup-signing';

/**
 * Sniper Guard Nuke batch: one reviewed, simulated full-balance sell per
 * wallet a triggered guard named. The user approves the whole batch once and
 * signs every sell locally in one step; each signed sell is then sent once.
 */
export const SNIPER_NUKE_MAX_WALLETS = 10;
export type SniperNukeSellState =
  | 'review'
  | 'signed'
  | 'submitting'
  | 'submitted'
  | 'finalized'
  | 'failed'
  | 'expired'
  | 'cancelled';
export type SniperNukeSell = {
  id: string;
  wallet: string;
  state: SniperNukeSellState;
  signature: string | null;
  review: WarmupSigningReview;
};
export type SniperNukeBatch = {
  batchId: string;
  reviewId: string;
  guardId: string;
  sells: SniperNukeSell[];
  skipped: { wallet: string; reason: string }[];
};
export type SniperNukeConsent = {
  approved: true;
  batchId: string;
  scope: 'sniper-guard-nuke-batch';
  sells: { id: string; sha256: string }[];
  acknowledgeFullBalanceSells: true;
};
export const sniperNukeConsent = (
  batch: SniperNukeBatch,
): SniperNukeConsent => ({
  approved: true,
  batchId: batch.batchId,
  scope: 'sniper-guard-nuke-batch',
  sells: batch.sells
    .filter((s) => s.state === 'review')
    .map((s) => ({ id: s.id, sha256: s.review.sha256 })),
  acknowledgeFullBalanceSells: true,
});

/** All-or-nothing: every vault identity and packet is checked before any signature. */
export async function signSniperNukeBatch(
  session: VaultSession,
  batch: SniperNukeBatch,
  assertCurrent: () => void,
) {
  const open = batch.sells.filter((s) => s.state === 'review');
  if (!open.length) throw new Error('No unsigned Nuke sells to sign.');
  for (const sell of open) {
    if (sell.review.wallet !== sell.wallet)
      throw new Error('Nuke sell wallet differs.');
    await requireApprovedWarmupPacket(sell.review, assertCurrent);
    if (
      !session.payload.wallets.some(
        (w) => w.family === 'solana' && w.address === sell.wallet,
      )
    )
      throw new Error(
        `Wallet ${sell.wallet} is not in this vault. Nothing was signed.`,
      );
  }
  const signed: { id: string; signature: string; transaction: string }[] = [];
  for (const sell of open)
    signed.push({
      id: sell.id,
      ...(await signApprovedWarmupPacket(session, sell.review, assertCurrent)),
    });
  return signed;
}

/**
 * Server check of one returned signed sell: identical message bytes to the
 * reviewed packet and a valid signature by the reviewed wallet.
 */
export async function verifySniperNukeSigned(
  review: WarmupSigningReview,
  transaction: string,
) {
  if (typeof transaction !== 'string' || transaction.length > 4000)
    throw new Error('Signed Nuke sell differs.');
  const reviewed = getTransactionDecoder().decode(
      getBase64Encoder().encode(review.transaction),
    ),
    signed = getTransactionDecoder().decode(
      getBase64Encoder().encode(transaction),
    );
  const a = Uint8Array.from(reviewed.messageBytes),
    b = Uint8Array.from(signed.messageBytes);
  if (a.length !== b.length || a.some((v, i) => v !== b[i]))
    throw new Error('Signed Nuke sell message differs from its review.');
  const message = getCompiledTransactionMessageDecoder().decode(
    signed.messageBytes,
  );
  if (
    message.header.numSignerAccounts !== 1 ||
    message.staticAccounts[0] !== review.wallet
  )
    throw new Error('Signed Nuke sell signer differs.');
  const signature = Object.values(signed.signatures)[0];
  if (
    !signature ||
    !verifySolanaSignature(
      b,
      Uint8Array.from(signature),
      bs58.decode(review.wallet),
    )
  )
    throw new Error('Signed Nuke sell signature is invalid.');
  return bs58.encode(Uint8Array.from(signature));
}
