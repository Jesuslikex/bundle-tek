import type { HolderIndexScan } from './holder-index';
import {
  holderExtensionNames,
  validateHolderMintObservation,
} from './holder-index-mint';

/** Account-withheld units stay outside owner balances and concentration totals. */
export function holderIndexWithheldFees(scan: HolderIndexScan) {
  let raw = 0n,
    reportedAccounts = 0,
    extensionAccounts = 0,
    unparseableAccounts = 0,
    confidentialAccounts = 0;
  for (const account of scan.accounts.values()) {
    if (account.extensions !== undefined) {
      const extensions = holderExtensionNames(account.extensions);
      extensionAccounts++;
      if (extensions.includes('unparseableExtension')) unparseableAccounts++;
      if (extensions.some((name) => name.startsWith('confidential')))
        confidentialAccounts++;
    }
    if (account.withheldRaw === undefined) continue;
    if (
      scan.tokenProgram !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ||
      scan.enumeration !== 'program-accounts-v2'
    )
      throw new Error('Withheld fee account provenance differs.');
    const value = account.withheldRaw;
    if (!/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n)
      throw new Error('Invalid withheld fee units.');
    raw += BigInt(value);
    reportedAccounts++;
  }
  if (scan.mintObservation) validateHolderMintObservation(scan.mintObservation);
  const mintRaw = scan.mintObservation?.withheldRaw ?? null;
  const remainder = BigInt(scan.totalSupplyRaw) - scan.indexedRaw;
  if (raw + BigInt(mintRaw ?? '0') > remainder)
    throw new Error(
      'Observed account and mint fees exceed unreconciled supply. Review the changing index.',
    );
  return {
    raw: raw.toString(),
    mintRaw,
    reportedAccounts,
    extensionAccounts,
    unparseableAccounts,
    confidentialAccounts,
    confidentialMint:
      scan.mintObservation?.extensions.some((name) =>
        name.startsWith('confidential'),
      ) ?? false,
    incompleteMintExtensions:
      scan.mintObservation?.extensions.includes('unparseableExtension') ??
      false,
    remainderAfterObservedFeesRaw: (
      remainder -
      raw -
      BigInt(mintRaw ?? '0')
    ).toString(),
  };
}
