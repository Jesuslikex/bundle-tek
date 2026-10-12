import type { HolderIndexScan } from './holder-index';

/** Account-withheld units stay outside owner balances and concentration totals. */
export function holderIndexWithheldFees(scan: HolderIndexScan) {
  let raw = 0n,
    reportedAccounts = 0;
  for (const account of scan.accounts.values()) {
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
  const remainder = BigInt(scan.totalSupplyRaw) - scan.indexedRaw;
  if (raw > remainder)
    throw new Error(
      'Account-withheld fees exceed unreconciled supply. Review the changing index.',
    );
  return {
    raw: raw.toString(),
    reportedAccounts,
    remainderAfterObservedFeesRaw: (remainder - raw).toString(),
  };
}
