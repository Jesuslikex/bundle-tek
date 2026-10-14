import type { getWallets } from '@wallet-standard/app';
import {
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit';
import bs58 from 'bs58';
import { verifySolanaSignature } from '@/lib/solana-signature';
import {
  requireApprovedWarmupPacket,
  type WarmupSigningReview,
} from './warmup-signing';
import {
  isExplicitSigningRejection,
  WalletSigningRejected,
} from './wallet-signing-rejection';

export type WarmupExternalWallet = ReturnType<
  ReturnType<typeof getWallets>['get']
>[number];
type Account = WarmupExternalWallet['accounts'][number];
type SignFeature = {
  version: '1.0.0';
  supportedTransactionVersions: readonly (0 | 'legacy')[];
  signTransaction: (
    ...inputs: {
      account: Account;
      transaction: Uint8Array;
      chain: 'solana:mainnet';
    }[]
  ) => Promise<readonly { signedTransaction: Uint8Array }[]>;
};
type ConnectFeature = { version: '1.0.0'; connect: () => Promise<unknown> };
type EventsFeature = {
  version: '1.0.0';
  on: (event: 'change', listener: () => void) => () => void;
};

function features(wallet: WarmupExternalWallet) {
  const sign = wallet.features['solana:signTransaction'] as
      | SignFeature
      | undefined,
    connect = wallet.features['standard:connect'] as ConnectFeature | undefined,
    events = wallet.features['standard:events'] as EventsFeature | undefined;
  if (
    !wallet.chains.includes('solana:mainnet') ||
    sign?.version !== '1.0.0' ||
    !Array.isArray(sign.supportedTransactionVersions) ||
    !sign.supportedTransactionVersions.includes(0) ||
    typeof sign.signTransaction !== 'function' ||
    connect?.version !== '1.0.0' ||
    typeof connect.connect !== 'function' ||
    events?.version !== '1.0.0' ||
    typeof events.on !== 'function'
  )
    throw new Error(
      'This wallet must support Solana mainnet, versioned transaction signing and account change events. Combined signing and sending is unavailable for this flow.',
    );
  return { sign, connect, events };
}
export function supportsWarmupExternalWallet(wallet: WarmupExternalWallet) {
  try {
    features(wallet);
    return true;
  } catch {
    return false;
  }
}
export function matchingWarmupExternalAccount(
  wallet: WarmupExternalWallet,
  address: string,
) {
  features(wallet);
  return wallet.accounts.find(
    (account) =>
      account.address === address &&
      account.chains.includes('solana:mainnet') &&
      account.features.includes('solana:signTransaction') &&
      account.publicKey.length === 32 &&
      bs58.encode(new Uint8Array(account.publicKey)) === address,
  );
}
export async function connectWarmupExternalWallet(
  wallet: WarmupExternalWallet,
  address: string,
) {
  await features(wallet).connect.connect();
  if (!matchingWarmupExternalAccount(wallet, address))
    throw new Error(
      'Connect the exact wallet shown in this preparation on Solana mainnet.',
    );
}
export function onWarmupExternalWalletChange(
  wallet: WarmupExternalWallet,
  listener: () => void,
) {
  return features(wallet).events.on('change', listener);
}
export async function signApprovedExternalWarmupPacket(
  wallet: WarmupExternalWallet,
  review: WarmupSigningReview,
  assertCurrent: () => void,
  retainSigned?: (signed: {
    signature: string;
    transaction: string;
  }) => Promise<void>,
) {
  const sign = features(wallet).sign,
    account = matchingWarmupExternalAccount(wallet, review.wallet);
  if (!account)
    throw new Error('Connected wallet differs from the reviewed wallet.');
  const { bytes, tx } = await requireApprovedWarmupPacket(
      review,
      assertCurrent,
    ),
    reviewedMessage = Uint8Array.from(tx.messageBytes);
  const requireCurrent = () => {
    assertCurrent();
    if (
      features(wallet).sign !== sign ||
      matchingWarmupExternalAccount(wallet, review.wallet) !== account ||
      Date.parse(review.expiresAt) <= Date.now()
    )
      throw new Error('Approval or connected wallet changed or expired.');
  };
  requireCurrent();
  let outputs;
  try {
    outputs = await sign.signTransaction({
      account,
      transaction: Uint8Array.from(bytes),
      chain: 'solana:mainnet',
    });
  } catch (error) {
    if (isExplicitSigningRejection(error))
      throw new WalletSigningRejected(error);
    throw new Error(
      'Wallet signing did not complete. No transaction was submitted by this app.',
    );
  }
  if (!retainSigned) requireCurrent();
  if (
    !Array.isArray(outputs) ||
    outputs.length !== 1 ||
    !(outputs[0]?.signedTransaction instanceof Uint8Array) ||
    outputs[0].signedTransaction.length > 1232
  )
    throw new Error('Wallet returned an unexpected signed transaction.');
  // Own the output immediately; the extension cannot mutate the registered packet later.
  const returned = Uint8Array.from(outputs[0].signedTransaction),
    signed = getTransactionDecoder().decode(returned),
    canonical = getTransactionEncoder().encode(signed),
    signature =
      signed.signatures[review.wallet as keyof typeof signed.signatures];
  if (
    canonical.length !== returned.length ||
    canonical.some((byte, index) => byte !== returned[index]) ||
    signed.messageBytes.length !== reviewedMessage.length ||
    signed.messageBytes.some((byte, index) => byte !== reviewedMessage[index])
  )
    throw new Error(
      'Wallet changed the reviewed transaction. Prepare and review a fresh order.',
    );
  if (
    Object.keys(signed.signatures).length !== 1 ||
    !signature ||
    signature.length !== 64 ||
    !verifySolanaSignature(
      reviewedMessage,
      Uint8Array.from(signature),
      bs58.decode(review.wallet),
    )
  )
    throw new Error('Wallet returned an invalid transaction signature.');
  const packet = {
    signature: bs58.encode(Uint8Array.from(signature)),
    transaction: getBase64Decoder().decode(returned),
  };
  // Signing already happened. Retain only the verified exact packet before
  // rejecting a now-expired UI or changed wallet. Retention must never submit.
  if (retainSigned) await retainSigned(packet);
  requireCurrent();
  return packet;
}
