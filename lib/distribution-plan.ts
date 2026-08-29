import bs58 from 'bs58';

export type DistributionRecipient = {
  address: string;
  amount: number;
  label: string;
  sourceLines: number[];
};

export type DistributionPlan = {
  recipients: DistributionRecipient[];
  batches: DistributionRecipient[][];
  totalAmount: number;
  distributableAmount: number;
  allocationPercent: number;
  warnings: string[];
};

export function isSolanaAddress(value: string) {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

export function toBaseUnits(amount: number, decimals: number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Transfer amount must be greater than zero.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new Error('Mint decimals must be between 0 and 9.');
  const scaled = amount * 10 ** decimals;
  if (!Number.isSafeInteger(scaled)) throw new Error('Transfer amount exceeds safe precision for this mint.');
  return BigInt(scaled);
}

export function buildDistributionPlan(input: {
  manifest: string;
  tokenSupply: number;
  reservePercent: number;
  batchSize: number;
}): DistributionPlan {
  const { manifest, tokenSupply, reservePercent } = input;
  if (!Number.isFinite(tokenSupply) || tokenSupply <= 0) throw new Error('Token supply must be greater than zero.');
  if (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent >= 100) throw new Error('Reserve must be between 0% and 99.99%.');
  const batchSize = Math.max(1, Math.min(12, Math.floor(input.batchSize)));
  const byAddress = new Map<string, DistributionRecipient>();
  const warnings: string[] = [];

  manifest.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const [rawAddress, rawAmount, ...rawLabel] = line.split(',').map((part) => part.trim());
    if (!rawAddress || !rawAmount) throw new Error(`Line ${lineNumber}: expected address, amount, optional label.`);
    if (!isSolanaAddress(rawAddress)) throw new Error(`Line ${lineNumber}: invalid Solana address.`);
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Line ${lineNumber}: amount must be greater than zero.`);
    if (!/^\d+(?:\.\d{1,9})?$/.test(rawAmount)) throw new Error(`Line ${lineNumber}: use at most 9 decimal places.`);
    const existing = byAddress.get(rawAddress);
    if (existing) {
      existing.amount += amount;
      existing.sourceLines.push(lineNumber);
      warnings.push(`Merged duplicate recipient on lines ${existing.sourceLines.join(' and ')}.`);
    } else {
      byAddress.set(rawAddress, { address: rawAddress, amount, label: rawLabel.join(', '), sourceLines: [lineNumber] });
    }
  });

  const recipients = [...byAddress.values()];
  if (!recipients.length) throw new Error('Add at least one recipient.');
  const totalAmount = recipients.reduce((sum, recipient) => sum + recipient.amount, 0);
  const distributableAmount = tokenSupply * (1 - reservePercent / 100);
  if (totalAmount > distributableAmount + Number.EPSILON) {
    throw new Error(`Distribution exceeds the ${distributableAmount.toLocaleString()} token limit after reserve.`);
  }
  const batches: DistributionRecipient[][] = [];
  for (let index = 0; index < recipients.length; index += batchSize) batches.push(recipients.slice(index, index + batchSize));
  return {
    recipients,
    batches,
    totalAmount,
    distributableAmount,
    allocationPercent: totalAmount / tokenSupply * 100,
    warnings,
  };
}
