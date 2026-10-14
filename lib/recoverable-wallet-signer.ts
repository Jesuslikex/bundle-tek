import bs58 from 'bs58';
import { verifySolanaSignature } from '@/lib/solana-signature';
import {
  isExplicitSigningRejection,
  WalletSigningRejected,
} from './wallet-signing-rejection';
import {
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  getSignatureFromTransaction,
  getTransactionCodec,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  type TransactionModifyingSigner,
  type TransactionSigner,
} from '@solana/kit';

export function assertRecoverableWalletSigner(signer: TransactionSigner) {
  if (
    !isTransactionModifyingSigner(signer) &&
    !isTransactionPartialSigner(signer)
  )
    throw new Error(
      'This wallet only supports combined signing and sending. Use a wallet that exposes transaction signing for recoverable submissions.',
    );
}

export function recoverableWalletSigner(
  signer: TransactionSigner,
  recordSignature: (signature: string) => Promise<void>,
  assertCurrent: () => void,
): TransactionModifyingSigner {
  assertRecoverableWalletSigner(signer);
  return {
    address: signer.address,
    async modifyAndSignTransactions(transactions, config) {
      if (transactions.length !== 1)
        throw new Error('Review exactly one transaction at a time.');
      const input = transactions[0];
      assertIsTransactionWithBlockhashLifetime(input);
      assertIsTransactionWithinSizeLimit(input);
      if (
        Object.keys(input.signatures).length !== 1 ||
        !(signer.address in input.signatures)
      )
        throw new Error(
          'The reviewed wallet must be the only transaction signer.',
        );
      assertCurrent();
      config?.abortSignal?.throwIfAborted();
      const reviewedBytes = new Uint8Array(input.messageBytes),
        reviewedLifetime = { ...input.lifetimeConstraint };
      const signOnly = async () =>
        isTransactionModifyingSigner(signer)
          ? await signer.modifyAndSignTransactions(transactions, config)
          : await (async () => {
              if (!isTransactionPartialSigner(signer))
                throw new Error('Transaction signing is unavailable.');
              const maps = await signer.signTransactions([input], config);
              return maps.map((signatures) => ({ ...input, signatures }));
            })();
      let outputs;
      try {
        outputs = await signOnly();
      } catch (error) {
        if (isExplicitSigningRejection(error))
          throw new WalletSigningRejected(error);
        throw error;
      }
      if (outputs.length !== 1)
        throw new Error('Wallet returned an unexpected transaction count.');
      const output = outputs[0];
      assertIsTransactionWithBlockhashLifetime(output);
      assertIsTransactionWithinSizeLimit(output);
      const codec = getTransactionCodec();
      // Own the returned buffers while registration is pending; the wallet cannot mutate our copy.
      const signed = {
        ...codec.decode(codec.encode(output)),
        lifetimeConstraint: { ...output.lifetimeConstraint },
      };
      assertIsTransactionWithBlockhashLifetime(signed);
      assertIsTransactionWithinSizeLimit(signed);
      if (
        signed.messageBytes.length !== reviewedBytes.length ||
        signed.messageBytes.some(
          (byte, index) => byte !== reviewedBytes[index],
        ) ||
        signed.lifetimeConstraint.blockhash !== reviewedLifetime.blockhash ||
        signed.lifetimeConstraint.lastValidBlockHeight !==
          reviewedLifetime.lastValidBlockHeight
      )
        throw new Error(
          'Wallet changed the reviewed transaction. No transaction was broadcast by this app.',
        );
      const signatures = Object.keys(signed.signatures),
        signature = signed.signatures[signer.address];
      if (
        signatures.length !== 1 ||
        signatures[0] !== signer.address ||
        !signature ||
        signature.length !== 64 ||
        !verifySolanaSignature(
          new Uint8Array(signed.messageBytes),
          new Uint8Array(signature),
          bs58.decode(signer.address),
        )
      )
        throw new Error('Wallet returned an invalid transaction signature.');
      // Preserve the signature even if the review changed while the wallet prompt was open.
      // The SDK cannot broadcast until this durable registration is acknowledged.
      await recordSignature(getSignatureFromTransaction(signed));
      assertCurrent();
      config?.abortSignal?.throwIfAborted();
      return [signed];
    },
  };
}
