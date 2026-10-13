import bs58 from 'bs58';
import type { JitoFinalization } from './jito-finalization';
import { UUID } from './wallet-operation';
import {
  requireApprovedWarmupPacket,
  type WarmupSigningReview,
} from './warmup-signing';
import {
  inspectNativeWithdrawal,
  type NativeWithdrawalReview,
} from './native-withdrawal';

export const JITO_ENDPOINT =
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
export const JITO_MAX_SWAPS = 4;
export type JitoBundleManifest = {
  format: 'jito-atomic-bundle-v1';
  id: string;
  projectId: string;
  sessionId: string;
  sessionRevision: number;
  createdAt: string;
  expiresAt: string;
  swaps: WarmupSigningReview[];
  tip: NativeWithdrawalReview;
  sha256: string;
};
export type JitoBundleState =
  | 'reviewed'
  | 'submitting'
  | 'submitted'
  | 'finalized'
  | 'cancelled'
  | 'expired';
export type JitoBundleRecord = {
  finalization?: JitoFinalization | null;
  manifest: JitoBundleManifest;
  state: JitoBundleState;
  bundleId: string | null;
  signatures: Array<string | null>;
  updatedAt: string;
};
export async function bundleFingerprint(
  value: Omit<JitoBundleManifest, 'sha256'>,
) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export function jitoTipLamports(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,7}$/.test(value) ||
    BigInt(value) < 1000n ||
    BigInt(value) > 10_000_000n
  )
    throw new Error(
      'Choose an explicit Jito tip from 1,000 to 10,000,000 lamports.',
    );
  return value;
}
export function jitoIntentSelection(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > JITO_MAX_SWAPS ||
    value.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
    new Set(value).size !== value.length
  )
    throw new Error('Choose one to four distinct unsigned session approvals.');
  return value;
}
export async function requireJitoManifest(
  value: JitoBundleManifest,
  current = true,
) {
  if (
    !value ||
    value.format !== 'jito-atomic-bundle-v1' ||
    !UUID.test(value.id) ||
    !UUID.test(value.projectId) ||
    !UUID.test(value.sessionId) ||
    !Number.isSafeInteger(value.sessionRevision) ||
    value.sessionRevision < 1 ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    throw new Error('Bundle identity differs.');
  const { sha256, ...terms } = value;
  if ((await bundleFingerprint(terms)) !== sha256)
    throw new Error('Bundle fingerprint differs.');
  jitoIntentSelection(value.swaps.map((s) => s.id));
  const wallets = new Set<string>();
  let lastEntry = 0;
  for (const review of value.swaps) {
    if (
      !review.session ||
      review.session.sessionId !== value.sessionId ||
      review.session.sessionRevision !== value.sessionRevision ||
      review.session.entry <= lastEntry ||
      wallets.has(review.wallet) ||
      review.network !== 'mainnet' ||
      Date.parse(review.expiresAt) < Date.parse(value.expiresAt)
    )
      throw new Error('Bundle order, wallet or session differs.');
    wallets.add(review.wallet);
    lastEntry = review.session.entry;
    if (current) await requireApprovedWarmupPacket(review, () => {});
  }
  const tip = value.tip;
  if (
    tip.token ||
    tip.funding ||
    tip.wallet !== value.swaps[0].wallet ||
    Date.parse(tip.expiresAt) < Date.parse(value.expiresAt)
  )
    throw new Error('Bundle tip payer differs.');
  jitoTipLamports(tip.amountRaw);
  await inspectNativeWithdrawal(tip, tip.transaction, false);
  if (current && Date.parse(value.expiresAt) <= Date.now())
    throw new Error('Bundle expired.');
  return value;
}
export function requireJitoSignatures(signatures: string[]) {
  if (
    signatures.length < 2 ||
    signatures.length > 5 ||
    new Set(signatures).size !== signatures.length ||
    signatures.some((s) => {
      try {
        return bs58.decode(s).length !== 64;
      } catch {
        return true;
      }
    })
  )
    throw new Error('Complete ordered bundle signatures required.');
  return signatures;
}
export function decodeJitoStatus(
  raw: unknown,
  bundleId: string,
  signatures: string[],
) {
  requireJitoSignatures(signatures);
  const data = raw as {
    value?: Array<null | {
      bundle_id?: string;
      transactions?: string[];
      slot?: number;
      confirmation_status?: string;
      confirmationStatus?: string;
      err?: unknown;
    }>;
  };
  if (!Array.isArray(data?.value) || data.value.length > 1)
    throw new Error('Bundle status unavailable.');
  if (!data.value.length || data.value[0] === null) return null;
  const result = data.value[0]!;
  if (
    result.bundle_id !== bundleId ||
    JSON.stringify(result.transactions) !== JSON.stringify(signatures) ||
    !Number.isSafeInteger(result.slot) ||
    result.slot! < 1 ||
    !['processed', 'confirmed', 'finalized'].includes(
      result.confirmation_status ?? result.confirmationStatus ?? '',
    ) ||
    !(result.err === null || JSON.stringify(result.err) === '{"Ok":null}')
  )
    throw new Error(
      'Bundle status does not match the exact ordered signatures.',
    );
  return {
    slot: result.slot!,
    commitment: result.confirmation_status ?? result.confirmationStatus!,
  };
}
