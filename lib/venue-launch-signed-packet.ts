import {
  address,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit';
import bs58 from 'bs58';
import { buildMeteoraDbcMessage } from './meteora-dbc-launch';
import type { MeteoraDbcReview } from './meteora-dbc-launch-service';
import { buildStonkLaunchMessage } from './stonkfun-launch';
import type { StonkLaunchReview } from './stonkfun-launch-service';
import { verifySolanaSignature } from './solana-signature';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => {
  throw new Error('Saved venue launch packet or signatures differ.');
};
const bytes = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
function canonicalKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    return false;
  try {
    const decoded = bs58.decode(value);
    return decoded.length === 32 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}
function canonicalPacket(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 1800) return false;
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

/** Pure authentication of retained packets. Expiry and current authorization belong to callers. */
export async function verifyVenueLaunchSignedPacket(
  review: MeteoraDbcReview | StonkLaunchReview,
  signed: string,
): Promise<string> {
  if (
    !record(review) ||
    !['meteora-dbc-launch-review-v1', 'stonkfun-launch-review-v1'].includes(
      review.format,
    ) ||
    !record(review.input) ||
    !record(review.terms) ||
    !record(review.summary) ||
    !canonicalPacket(review.transaction) ||
    typeof review.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(review.sha256) ||
    !canonicalPacket(signed)
  )
    return fail();
  const { payer, mint } = review.input;
  if (
    !canonicalKey(payer) ||
    !canonicalKey(mint) ||
    payer === mint ||
    review.terms.payer !== payer ||
    review.terms.mint !== mint ||
    review.terms.devBuyRaw !== review.input.devBuyRaw ||
    review.summary.devBuyRaw !== review.input.devBuyRaw ||
    typeof review.summary.pool !== 'string'
  )
    return fail();
  if (
    review.format === 'meteora-dbc-launch-review-v1' &&
    (review.terms.config !== review.input.config ||
      review.summary.config !== review.input.config)
  )
    return fail();
  const built =
    review.format === 'meteora-dbc-launch-review-v1'
      ? await buildMeteoraDbcMessage(review.input)
      : await buildStonkLaunchMessage(review.input);
  if (
    built.transaction !== review.transaction ||
    built.packetSha256 !== review.sha256 ||
    built.pool !== review.summary.pool
  )
    return fail();
  const decode = getTransactionDecoder();
  const original = decode.decode(bytes(built.transaction));
  const tx = decode.decode(bytes(signed));
  if (
    getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !== signed ||
    tx.messageBytes.length !== original.messageBytes.length ||
    !tx.messageBytes.every(
      (byte, index) => byte === original.messageBytes[index],
    )
  )
    return fail();
  const keys = Object.keys(tx.signatures);
  if (keys.length !== 2 || keys[0] !== payer || !keys.includes(mint))
    return fail();
  for (const key of [payer, mint]) {
    const signature = tx.signatures[address(key)];
    if (
      !signature ||
      !verifySolanaSignature(
        Uint8Array.from(tx.messageBytes),
        Uint8Array.from(signature),
        bs58.decode(key),
      )
    )
      return fail();
  }
  return bs58.encode(tx.signatures[address(payer)]!);
}
