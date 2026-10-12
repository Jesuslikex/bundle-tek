import bs58 from 'bs58';
import {
  inspectNativeWithdrawal,
  type NativeWithdrawalReview,
} from './native-withdrawal';
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (review: NativeWithdrawalReview) =>
  `pulseforge.native-withdrawal-signature:${review.id}`;
export async function retainNativeWithdrawalSignature(
  review: NativeWithdrawalReview,
  signed: { signature: string; transaction: string },
  storage: StorageLike,
) {
  const verified = await inspectNativeWithdrawal(
    review,
    signed.transaction,
    true,
  );
  if (verified.signature !== signed.signature)
    throw new Error('Returned withdrawal signature differs.');
  storage.setItem(
    key(review),
    JSON.stringify({
      wallet: review.wallet,
      sha256: review.sha256,
      signature: signed.signature,
    }),
  );
}
export async function restoreNativeWithdrawalSignature(
  review: NativeWithdrawalReview,
  storage: StorageLike,
) {
  const text = storage.getItem(key(review));
  if (!text) return null;
  const saved = JSON.parse(text) as {
    wallet: string;
    sha256: string;
    signature: string;
  };
  if (
    saved.wallet !== review.wallet ||
    saved.sha256 !== review.sha256 ||
    typeof saved.signature !== 'string' ||
    saved.signature.length > 90
  )
    throw new Error('Retained local withdrawal signature context differs.');
  const signature = bs58.decode(saved.signature);
  if (signature.length !== 64)
    throw new Error('Retained local withdrawal signature differs.');
  const bytes = Uint8Array.from(atob(review.transaction), (c) =>
    c.charCodeAt(0),
  );
  bytes.set(signature, 1);
  const transaction = btoa(String.fromCharCode(...bytes));
  await inspectNativeWithdrawal(review, transaction, true);
  return { signature: saved.signature, transaction };
}
export function clearNativeWithdrawalSignature(
  review: NativeWithdrawalReview,
  storage: StorageLike,
) {
  try {
    storage.removeItem(key(review));
  } catch {
    // Durable registration already succeeded. Storage cleanup cannot undo it.
  }
}
