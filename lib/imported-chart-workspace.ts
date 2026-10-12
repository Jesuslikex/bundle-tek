import type { ImportedSwapReceipt } from './imported-approval-history';
import bs58 from 'bs58';
import { walletAddress } from './wallet-workspace';
export function importedChartWorkspaceId(projectId: string) {
  if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(projectId))
    throw new Error('Invalid chart project.');
  return `imported-chart-${projectId}`;
}
export function finalizedReceiptChartTarget(receipt: ImportedSwapReceipt) {
  try {
    const target = importedChartWorkspaceId(receipt.projectId),
      d = receipt.document;
    if (
      !d ||
      d.network !== 'mainnet' ||
      d.commitment !== 'finalized' ||
      d.signatureVerified !== true ||
      !['Buy', 'Sell'].includes(d.side) ||
      !Number.isSafeInteger(receipt.projectRevision) ||
      receipt.projectRevision < 1 ||
      bs58.decode(d.signature).length !== 64 ||
      !/^[1-9]\d{0,19}$/.test(d.tokenUnitsRaw) ||
      BigInt(d.tokenUnitsRaw) > (1n << 64n) - 1n
    )
      return null;
    walletAddress(d.mint, 'Solana');
    walletAddress(d.wallet, 'Solana');
    return target;
  } catch {
    return null;
  }
}
