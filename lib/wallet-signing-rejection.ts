// These markers apply only to signing-only requests, before a signed result exists.
export class VaultApprovalCancelled extends Error {
  constructor() {
    super('Browser vault approval was cancelled.');
    this.name = 'VaultApprovalCancelled';
  }
}
export class WalletSigningRejected extends Error {
  constructor(cause: unknown) {
    super(
      'Wallet signing was rejected. No transaction was submitted by this app.',
      { cause },
    );
    this.name = 'WalletSigningRejected';
  }
}
export function isExplicitSigningRejection(error: unknown) {
  return (
    error instanceof VaultApprovalCancelled ||
    (error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 4001)
  );
}
