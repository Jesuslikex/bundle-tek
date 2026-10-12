import type { ImportedSwapReceipt } from './imported-approval-history';
import type { ImportedTokenProject } from './imported-token-project';
import type { WorkspaceWallet } from './wallet-workspace';
import { walletAddress } from './wallet-workspace';
import { UUID } from './wallet-operation';
import { formatNativeBalance } from './wallet-balance-format';
import { solanaTokenAtoms } from './solana-token-amount';
export type ImportedSellHandoff = ReturnType<typeof importedSellHandoff>;
export function importedSellHandoff(
  receipt: ImportedSwapReceipt,
  project: ImportedTokenProject,
) {
  const token = project.document.token,
    evidence = receipt?.document;
  if (
    project.archived ||
    token.chain !== 'Solana' ||
    receipt?.projectId !== project.id ||
    !UUID.test(receipt.id) ||
    !UUID.test(receipt.preparationId) ||
    !Number.isSafeInteger(receipt.projectRevision) ||
    receipt.projectRevision < 1 ||
    receipt.projectRevision > project.revision ||
    !Number.isSafeInteger(receipt.walletRevision) ||
    receipt.walletRevision < 1 ||
    evidence?.side !== 'Buy' ||
    evidence.network !== 'mainnet' ||
    evidence.commitment !== 'finalized' ||
    evidence.signatureVerified !== true ||
    evidence.mint !== token.address ||
    evidence.decimals !== token.decimals ||
    !/^[a-f0-9]{64}$/.test(evidence.preparationSha256) ||
    !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(evidence.signature) ||
    !/^[1-9]\d{0,19}$/.test(evidence.tokenUnitsRaw) ||
    BigInt(evidence.tokenUnitsRaw) > (1n << 64n) - 1n
  )
    throw new Error(
      'Choose a finalized matching buy receipt for this active Solana import.',
    );
  const wallet = walletAddress(evidence.wallet, 'Solana'),
    amount = formatNativeBalance(evidence.tokenUnitsRaw, token.decimals);
  if (
    solanaTokenAtoms(amount, token.decimals).toString() !==
    evidence.tokenUnitsRaw
  )
    throw new Error('Receipt amount cannot be restored exactly.');
  return {
    projectId: project.id,
    projectRevision: project.revision,
    sourceProjectRevision: receipt.projectRevision,
    receiptId: receipt.id,
    preparationId: receipt.preparationId,
    signature: evidence.signature,
    wallet,
    walletRevision: receipt.walletRevision,
    mint: evidence.mint,
    tokenUnitsRaw: evidence.tokenUnitsRaw,
    decimals: evidence.decimals,
    amount,
    side: 'Sell' as const,
  };
}
export function currentImportedSellHandoff(
  handoff: ImportedSellHandoff,
  project: ImportedTokenProject,
) {
  if (
    project.archived ||
    project.document.token.chain !== 'Solana' ||
    handoff.projectId !== project.id ||
    handoff.projectRevision !== project.revision ||
    handoff.mint !== project.document.token.address ||
    handoff.decimals !== project.document.token.decimals ||
    handoff.side !== 'Sell' ||
    solanaTokenAtoms(handoff.amount, handoff.decimals).toString() !==
      handoff.tokenUnitsRaw
  )
    throw new Error(
      'Sell handoff changed. Review a matching buy receipt again.',
    );
  return handoff;
}
export function importedHandoffWallet(
  handoff: ImportedSellHandoff,
  wallets: WorkspaceWallet[],
) {
  return (
    wallets.find(
      (wallet) =>
        wallet.chain === 'Solana' &&
        !wallet.archived &&
        wallet.address === handoff.wallet &&
        wallet.revision === handoff.walletRevision,
    ) ?? null
  );
}
