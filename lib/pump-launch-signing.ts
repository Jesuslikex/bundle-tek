import {
  address,
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  type SignatureBytes,
} from '@solana/kit';
import nacl from 'tweetnacl';
import { verifySolanaSignature } from '@/lib/solana-signature';
import bs58 from 'bs58';
import {
  buildPumpCreateMessage,
  type PumpCreateInput,
} from './pump-launch-message';
import type { VaultSession } from './browser-wallet-vault';

export type PumpSigningInput = Omit<
  PumpCreateInput,
  'lastValidBlockHeight' | 'global' | 'quoteMintAccount' | 'quoteControl'
> & {
  lastValidBlockHeight: string;
  global: EncodedAccount;
  quoteMintAccount?: EncodedAccount;
  quoteControl?: EncodedAccount;
};
type EncodedAccount = Omit<PumpCreateInput['global'], 'data'> & {
  data: string;
};
export type PumpSigningReview = {
  id: string;
  projectId: string;
  projectUpdatedAt: string;
  releaseId: string;
  expiresAt: string;
  transaction: string;
  sha256: string;
  input: PumpSigningInput;
  feeAndRentLimitRaw: string;
};
export function encodePumpSigningInput(
  input: PumpCreateInput,
): PumpSigningInput {
  const encode = (a: PumpCreateInput['global']): EncodedAccount => ({
    ...a,
    data: getBase64Decoder().decode(a.data),
  });
  const { global, quoteMintAccount, quoteControl, ...base } = input;
  return {
    ...base,
    lastValidBlockHeight: input.lastValidBlockHeight.toString(),
    global: encode(global),
    ...(quoteMintAccount ? { quoteMintAccount: encode(quoteMintAccount) } : {}),
    ...(quoteControl ? { quoteControl: encode(quoteControl) } : {}),
  };
}
export async function requirePumpSigningReview(
  review: PumpSigningReview,
  current: () => void = () => {},
) {
  current();
  if (
    !review ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    Date.parse(review.expiresAt) <= Date.now() ||
    !/^[1-9]\d{0,19}$/.test(review.feeAndRentLimitRaw) ||
    BigInt(review.feeAndRentLimitRaw) > 1000000000n
  )
    throw new Error('Launch review expired or allowance differs.');
  const decode = (a: EncodedAccount) => {
    if (a.data.length > 270000 || btoa(atob(a.data)) !== a.data)
      throw new Error('Launch configuration differs.');
    return {
      ...a,
      data: Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0)),
    };
  };
  const { global, quoteMintAccount, quoteControl, ...base } = review.input;
  const input: PumpCreateInput = {
    ...base,
    lastValidBlockHeight: BigInt(review.input.lastValidBlockHeight),
    global: decode(global),
    ...(quoteMintAccount ? { quoteMintAccount: decode(quoteMintAccount) } : {}),
    ...(quoteControl ? { quoteControl: decode(quoteControl) } : {}),
  };
  const built = await buildPumpCreateMessage(input);
  if (
    built.packetSha256 !== review.sha256 ||
    built.transaction !== review.transaction
  )
    throw new Error(
      'Launch packet differs from its reviewed identity, quote or instructions.',
    );
  current();
  return getTransactionDecoder().decode(
    Uint8Array.from(atob(review.transaction), (c) => c.charCodeAt(0)),
  );
}
export async function signPumpLaunch(
  payerSession: VaultSession,
  mintSession: VaultSession,
  review: PumpSigningReview,
  current: () => void,
) {
  const tx = await requirePumpSigningReview(review, current);
  const signatures: Record<string, SignatureBytes> = {};
  for (const [session, key] of [
    [payerSession, review.input.payer],
    [mintSession, review.input.mint],
  ] as const) {
    const wallet = session.payload.wallets.find(
      (w) => w.family === 'solana' && w.address === key,
    );
    if (!wallet || !/^[0-9a-f]{64}$/.test(wallet.seed))
      throw new Error('Unlock the exact reviewed payer and mint keys.');
    const seed = Uint8Array.from(wallet.seed.match(/../g)!, (b) =>
      parseInt(b, 16),
    );
    const pair = nacl.sign.keyPair.fromSeed(seed);
    try {
      current();
      if (bs58.encode(pair.publicKey) !== key)
        throw new Error('Launch key identity differs.');
      signatures[address(key)] = nacl.sign.detached(
        Uint8Array.from(tx.messageBytes),
        pair.secretKey,
      ) as SignatureBytes;
    } finally {
      seed.fill(0);
      pair.secretKey.fill(0);
    }
  }
  current();
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Launch review expired.');
  return {
    transaction: getBase64Decoder().decode(
      getTransactionEncoder().encode({ ...tx, signatures }),
    ),
    signature: bs58.encode(signatures[review.input.payer]),
  };
}
export function verifyPumpSignedPacket(
  review: PumpSigningReview,
  signed: string,
) {
  if (signed.length > 1700 || btoa(atob(signed)) !== signed)
    throw new Error('Invalid signed launch packet.');
  const decode = (v: string) =>
    getTransactionDecoder().decode(
      Uint8Array.from(atob(v), (c) => c.charCodeAt(0)),
    );
  const original = decode(review.transaction),
    tx = decode(signed);
  if (
    getBase64Decoder().decode(tx.messageBytes) !==
      getBase64Decoder().decode(original.messageBytes) ||
    getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !== signed ||
    Object.keys(tx.signatures).length !== 2
  )
    throw new Error('Signed launch message changed.');
  for (const key of [review.input.payer, review.input.mint]) {
    const sig = tx.signatures[address(key)];
    if (
      !sig ||
      !verifySolanaSignature(
        Uint8Array.from(tx.messageBytes),
        Uint8Array.from(sig),
        bs58.decode(key),
      )
    )
      throw new Error('Both exact launch signatures are required.');
  }
  return bs58.encode(tx.signatures[address(review.input.payer)]!);
}
