import type { getWallets } from '@wallet-standard/app';
import {
  inspectNativeWithdrawal,
  type NativeWithdrawalReview,
} from './native-withdrawal';
import {
  isExplicitSigningRejection,
  WalletSigningRejected,
} from './wallet-signing-rejection';
import bs58 from 'bs58';
export type NativeWithdrawalExternalWallet = ReturnType<
  ReturnType<typeof getWallets>['get']
>[number];
type Account = NativeWithdrawalExternalWallet['accounts'][number];
type SignFeature = {
  version: '1.0.0';
  supportedTransactionVersions: readonly (0 | 'legacy')[];
  signTransaction: (
    ...input: {
      account: Account;
      transaction: Uint8Array;
      chain: 'solana:mainnet';
    }[]
  ) => Promise<readonly { signedTransaction: Uint8Array }[]>;
};
function features(wallet: NativeWithdrawalExternalWallet) {
  const sign = wallet.features['solana:signTransaction'] as
      | SignFeature
      | undefined,
    connect = wallet.features['standard:connect'] as
      | { version: string; connect: () => Promise<unknown> }
      | undefined,
    events = wallet.features['standard:events'] as
      | {
          version: string;
          on: (event: 'change', listener: () => void) => () => void;
        }
      | undefined;
  if (
    !wallet.chains.includes('solana:mainnet') ||
    sign?.version !== '1.0.0' ||
    !sign.supportedTransactionVersions?.includes('legacy') ||
    typeof sign.signTransaction !== 'function' ||
    connect?.version !== '1.0.0' ||
    typeof connect.connect !== 'function' ||
    events?.version !== '1.0.0' ||
    typeof events.on !== 'function'
  )
    throw new Error(
      'Use a mainnet wallet with legacy sign-only transactions and account change events.',
    );
  return { sign, connect, events };
}
export function supportsNativeWithdrawalWallet(
  wallet: NativeWithdrawalExternalWallet,
) {
  try {
    features(wallet);
    return true;
  } catch {
    return false;
  }
}
export function matchingNativeWithdrawalAccount(
  wallet: NativeWithdrawalExternalWallet,
  address: string,
) {
  features(wallet);
  return wallet.accounts.find(
    (account) =>
      account.address === address &&
      account.chains.includes('solana:mainnet') &&
      account.features.includes('solana:signTransaction') &&
      account.publicKey.length === 32 &&
      bs58.encode(Uint8Array.from(account.publicKey)) === address,
  );
}
export async function connectNativeWithdrawalWallet(
  wallet: NativeWithdrawalExternalWallet,
  address: string,
) {
  await features(wallet).connect.connect();
  if (!matchingNativeWithdrawalAccount(wallet, address))
    throw new Error('Connect the exact mainnet withdrawal wallet.');
}
export function onNativeWithdrawalWalletChange(
  wallet: NativeWithdrawalExternalWallet,
  listener: () => void,
) {
  return features(wallet).events.on('change', listener);
}
export async function signExternalNativeWithdrawal(
  wallet: NativeWithdrawalExternalWallet,
  review: NativeWithdrawalReview,
  assertCurrent: () => void,
  register: (signed: {
    signature: string;
    transaction: string;
  }) => Promise<void>,
  hooks?: { beforeSign?: () => Promise<void>; onSignerStart?: () => void },
) {
  const { bytes } = await inspectNativeWithdrawal(
      review,
      review.transaction,
      false,
    ),
    sign = features(wallet).sign,
    account = matchingNativeWithdrawalAccount(wallet, review.wallet);
  assertCurrent();
  if (!account || Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Withdrawal wallet differs or approval expired.');
  if (hooks?.beforeSign) {
    const originalReview = JSON.stringify(review);
    await hooks.beforeSign();
    assertCurrent();
    const rechecked = await inspectNativeWithdrawal(
      review,
      review.transaction,
      false,
    );
    if (
      JSON.stringify(review) !== originalReview ||
      rechecked.bytes.length !== bytes.length ||
      rechecked.bytes.some((byte, index) => byte !== bytes[index])
    )
      throw new Error('Withdrawal packet changed during signer preparation.');
    assertCurrent();
    if (
      features(wallet).sign.signTransaction !== sign.signTransaction ||
      matchingNativeWithdrawalAccount(wallet, review.wallet) !== account ||
      Date.parse(review.expiresAt) <= Date.now()
    )
      throw new Error('Withdrawal wallet differs or approval expired.');
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
      'Wallet signing outcome is unknown. Reload withdrawal recovery; no transaction was submitted by this app.',
    );
  }
  if (
    !Array.isArray(outputs) ||
    outputs.length !== 1 ||
    !(outputs[0]?.signedTransaction instanceof Uint8Array) ||
    outputs[0].signedTransaction.length > 1232
  )
    throw new Error('Wallet returned an unexpected withdrawal packet.');
  const returned = Uint8Array.from(outputs[0].signedTransaction),
    transaction = btoa(String.fromCharCode(...returned));
  const verified = await inspectNativeWithdrawal(review, transaction, true);
  if (!verified.signature) throw new Error();
  const signed = { transaction, signature: verified.signature };
  // Retain an exact returned signature before checking an account change or expired UI.
  await register(signed);
  assertCurrent();
  if (
    features(wallet).sign !== sign ||
    matchingNativeWithdrawalAccount(wallet, review.wallet) !== account
  )
    throw new Error(
      'Wallet changed after signing. Recover the retained signature without resending.',
    );
  return signed;
}
