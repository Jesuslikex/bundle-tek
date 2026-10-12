import { validateFunding } from './funding-plan';
import { chainQuoteAssets } from './quote-catalog';
import {
  operationDocument,
  type WalletOperationDocument,
} from './wallet-operation';
import { toBaseUnits } from './distribution-plan';

export function devnetFundingDocument(value: unknown, now = Date.now()) {
  const document = validateFunding(value);
  if (
    document.chain !== 'Solana' ||
    document.source !== 'Wallet' ||
    !document.funderAddress ||
    document.delaySeconds !== 0 ||
    Date.parse(document.startAt) > now
  )
    throw new Error(
      'Devnet funding requires an immediate saved Solana wallet draft with zero delay.',
    );
  const asset = document.assetAddress
    ? chainQuoteAssets('Solana').find(
        (row) => row.address === document.assetAddress,
      )
    : undefined;
  if (!asset && (document.assetAddress || document.currency !== 'SOL'))
    throw new Error('Select an explicit captured token mint or native SOL.');
  return {
    document,
    asset: asset
      ? { mint: asset.address, decimals: asset.decimals, symbol: asset.symbol }
      : null,
  };
}

export async function savedFundingIntent(
  value: unknown,
  id: string,
  revision: number,
  recipient: string,
) {
  const { document, asset } = devnetFundingDocument(value);
  const row = document.recipients.find((item) => item.address === recipient);
  if (!row) throw new Error('Recipient is not in the saved funding draft.');
  toBaseUnits(row.amount, asset?.decimals ?? 9);
  const intent = await operationDocument(
    asset
      ? {
          kind: 'spl',
          wallet: document.funderAddress,
          recipient,
          distribution: {
            wallet: document.funderAddress,
            mint: asset.mint,
            recipients: [row],
          },
          funding: { id, revision },
        }
      : {
          kind: 'sol',
          wallet: document.funderAddress,
          recipient,
          amount: row.amount,
          fundingId: id,
          fundingRevision: revision,
        },
  );
  return intent;
}

export function fundingLink(intent: WalletOperationDocument) {
  return intent.kind === 'sol'
    ? {
        id: intent.fundingId,
        revision: intent.fundingRevision,
        key: intent.fundingKey,
      }
    : intent.kind === 'spl'
      ? intent.funding
      : undefined;
}
