import { transactionSignature } from './transaction-signature';

/** Lookup coordinates only. Never an approval, receipt or execution capability. */
export type AutoSellOutcomeReference = Readonly<{
  projectId: string;
  projectRevision: number;
  walletRevision: number;
  preparationId: string;
  intentId: string;
  wallet: string;
  mint: string;
  inputRaw: string;
  preparationSha256: string;
  signature: string;
}>;
// Match the existing saved-signing GET's lowercase UUID syntax.
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function validatedAutoSellOutcomeReference(
  value: unknown,
): AutoSellOutcomeReference {
  const ref = value as AutoSellOutcomeReference;
  const fail = () => {
    throw Error('Saved Auto Sell lookup context is unavailable.');
  };
  if (
    !ref ||
    typeof ref !== 'object' ||
    Array.isArray(ref) ||
    ![ref.projectId, ref.preparationId, ref.intentId].every(
      (v) => typeof v === 'string' && uuid.test(v),
    ) ||
    ![ref.projectRevision, ref.walletRevision].every(
      (v) => Number.isSafeInteger(v) && v > 0,
    ) ||
    ![ref.wallet, ref.mint].every(
      (v) => typeof v === 'string' && address.test(v),
    ) ||
    typeof ref.inputRaw !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(ref.inputRaw) ||
    BigInt(ref.inputRaw) > (1n << 64n) - 1n ||
    typeof ref.preparationSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ref.preparationSha256)
  )
    fail();
  transactionSignature(ref.signature);
  return Object.freeze({
    projectId: ref.projectId,
    projectRevision: ref.projectRevision,
    walletRevision: ref.walletRevision,
    preparationId: ref.preparationId,
    intentId: ref.intentId,
    wallet: ref.wallet,
    mint: ref.mint,
    inputRaw: ref.inputRaw,
    preparationSha256: ref.preparationSha256,
    signature: ref.signature,
  });
}
