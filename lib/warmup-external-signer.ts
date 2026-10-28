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
// Phantom keeps wallet.accounts stale for a moment after a network switch and
// empties it outside a live prompt, so fall back to the wallet's own publicKey.
export async function resolveWarmupExternalAccount(
  wallet: WarmupExternalWallet,
  address: string,
): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const hit: any = matchingWarmupExternalAccount(wallet, address);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  // Phantom exposes the selected account on publicKey; the wallet-standard
  // object itself often has none, so fall back to the injected provider.
  const key =
    (wallet as any).publicKey ??
    (globalThis as any).phantom?.solana?.publicKey ??
    null;
  (globalThis as any).__key = JSON.stringify({
    w: String((wallet as any).publicKey ?? null),
    g: String((globalThis as any).phantom?.solana?.publicKey ?? null),
    a: address,
  });
  if (!key || key.toString?.() !== address) return undefined;
  return {
    address,
    publicKey: new Uint8Array(key.toBytes()),
    chains: ['solana:mainnet'],
    features: ['solana:signTransaction'],
    label: address,
  } as any;
}
export async function connectWarmupExternalWallet(
  wallet: WarmupExternalWallet,
  address: string,
) {
  await features(wallet).connect.connect();
  (globalThis as any).__acc = JSON.stringify(
    wallet.accounts.map((a) => ({
      c: a.chains,
      f: a.features,
      l: a.publicKey.length,
      m: bs58.encode(new Uint8Array(a.publicKey)),
    })),
  );
  const hit = await resolveWarmupExternalAccount(wallet, address);
  (globalThis as any).__acc2 = JSON.stringify({
    hit: !!hit,
    address,
    n: wallet.accounts.length,
    cmp: wallet.accounts.map((a) => [
      String(a.address),
      a.address === address,
      a.chains.includes('solana:mainnet'),
      a.features.includes('solana:signTransaction'),
      a.publicKey.length,
    ]),
  });
  if (!hit)
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
  hooks?: { beforeSign?: () => Promise<void>; onSignerStart?: () => void },
) {
  const sign = features(wallet).sign,
    account = await resolveWarmupExternalAccount(wallet, review.wallet);
  if (!account)
    throw new Error('Connected wallet differs from the reviewed wallet.');
  const { bytes, tx } = await requireApprovedWarmupPacket(
      review,
      assertCurrent,
    ),
    reviewedMessage = Uint8Array.from(tx.messageBytes);
  const signer = sign.signTransaction;
  const requireCurrent = () => {
    assertCurrent();
    // Phantom rebuilds its feature object on each access, so compare the
    // account, the signer function and the expiry rather than the feature
    // object identity.
    const swapped = features(wallet).sign?.signTransaction !== signer;
    // Phantom empties wallet.accounts outside a live prompt, so fall back to
    // the account captured when the approval was taken.
    const matched = matchingWarmupExternalAccount(wallet, review.wallet);
    const current =
      matched ||
      ((wallet as any).publicKey?.toString?.() === review.wallet
        ? account
        : undefined);
    const why = [
      (wallet.accounts.length > 0 && !matched) ||
      (current && current !== account)
        ? 'account'
        : '',
      swapped ? 'feature' : '',
      Date.parse(review.expiresAt) <= Date.now() ? 'expired' : '',
    ]
      .filter(Boolean)
      .join(',');
    if (why)
      throw new Error(
        `Approval or connected wallet changed or expired. (${why})`,
      );
  };
  requireCurrent();
  if (hooks?.beforeSign) {
    const originalReview = JSON.stringify(review);
    await hooks.beforeSign();
    requireCurrent();
    const rechecked = await requireApprovedWarmupPacket(review, assertCurrent);
    if (
      JSON.stringify(review) !== originalReview ||
      rechecked.bytes.length !== bytes.length ||
      rechecked.bytes.some((byte, index) => byte !== bytes[index])
    )
      throw new Error('Approved packet changed during signer preparation.');
    requireCurrent();
  }
  hooks?.onSignerStart?.();
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
