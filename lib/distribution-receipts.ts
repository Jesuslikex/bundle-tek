import bs58 from 'bs58';
import {
  canonicalDistributionAmount,
  isSolanaAddress,
  type DistributionRecipient,
} from './distribution-plan';

export type DistributionReceipt = {
  address: string;
  amount: string;
  signature: string;
  confirmedAt: string;
};

export function remainingDistributionRecipients(
  recipients: DistributionRecipient[],
  receipts: DistributionReceipt[],
) {
  return recipients.filter(
    (recipient) =>
      !receipts.some(
        (receipt) =>
          receipt.address === recipient.address &&
          receipt.amount === recipient.amount,
      ),
  );
}

// Shape validation is not chain verification. Keep existing numeric receipts readable.
export function readDistributionReceipts(
  serialized: string | null,
): DistributionReceipt[] {
  if (serialized === null) return [];
  if (serialized.length > 512_000)
    throw new Error('Local receipt data exceeds its limit.');
  const value: unknown = JSON.parse(serialized);
  if (!Array.isArray(value) || value.length > 1_000)
    throw new Error('Invalid local receipt collection.');
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object')
      throw new Error('Invalid local receipt.');
    const receipt = item as Record<string, unknown>;
    if (
      typeof receipt.address !== 'string' ||
      !isSolanaAddress(receipt.address) ||
      typeof receipt.signature !== 'string' ||
      receipt.signature.length > 90 ||
      bs58.decode(receipt.signature).length !== 64 ||
      typeof receipt.confirmedAt !== 'string' ||
      receipt.confirmedAt.length > 40 ||
      !Number.isFinite(Date.parse(receipt.confirmedAt)) ||
      (typeof receipt.amount !== 'string' && typeof receipt.amount !== 'number')
    )
      throw new Error('Invalid local receipt fields.');
    const amount = canonicalDistributionAmount(receipt.amount);
    if (amount === '0') throw new Error('Invalid local receipt amount.');
    return {
      address: receipt.address,
      amount,
      signature: receipt.signature,
      confirmedAt: receipt.confirmedAt,
    };
  });
}
