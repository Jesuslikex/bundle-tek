import { chainQuoteAssets } from './quote-catalog';
import bs58 from 'bs58';
import { CHAINS, CURRENCIES_BY_CHAIN, type LaunchChain } from './launch-plan';

export type FundingInput = {
  name: string;
  chain: LaunchChain;
  currency: string;
  assetAddress?: string;
  source: 'Wallet' | 'CEX' | 'Manual';
  sourceLabel: string;
  funderAddress: string;
  startAt: string;
  delaySeconds: number;
  // Classic funding: optional owned proxy wallets each transfer passes through, in order.
  recipients: { address: string; amount: string; proxies?: string[] }[];
};
export type FundingDocument = FundingInput & {
  total: string;
  items: {
    address: string;
    amount: string;
    scheduledAt: string;
    proxies?: string[];
  }[];
};
export type SavedFunding = {
  id: string;
  revision: number;
  archived: boolean;
  updatedAt: string;
  document: FundingDocument;
};
export type FundingEvent = {
  id: number;
  planId: string;
  name: string;
  chain: string;
  type: string;
  createdAt: string;
  revision: number;
};

function address(value: unknown, chain: LaunchChain): string {
  if (typeof value !== 'string')
    throw new Error('A public wallet address is required.');
  const clean = value.trim();
  if (chain === 'Solana') {
    try {
      if (bs58.decode(clean).length === 32) return clean;
    } catch {
      /* Invalid public address. */
    }
  } else if (/^0x[0-9a-fA-F]{40}$/.test(clean)) return clean.toLowerCase();
  throw new Error(`Invalid ${chain} public address.`);
}
function decimal(atoms: bigint, decimals: number) {
  const padded = atoms.toString().padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
export function validateFunding(value: unknown): FundingDocument {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid funding plan.');
  const v = value as FundingInput;
  const asset =
    v.assetAddress === undefined
      ? undefined
      : chainQuoteAssets(v.chain).find(
          (a) =>
            typeof v.assetAddress === 'string' &&
            (v.chain === 'Solana'
              ? a.address === v.assetAddress
              : a.address.toLowerCase() === v.assetAddress.toLowerCase()),
        );
  if (v.assetAddress !== undefined && (!asset || asset.symbol !== v.currency))
    throw new Error(
      'Select a captured funding asset matching the currency and network.',
    );
  if (
    !CHAINS.includes(v.chain) ||
    (!asset && !CURRENCIES_BY_CHAIN[v.chain]?.includes(v.currency))
  )
    throw new Error('Unsupported funding chain or currency.');
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.trim().length > 80)
    throw new Error('Plan name must be 1 to 80 characters.');
  if (
    !['Wallet', 'CEX', 'Manual'].includes(v.source) ||
    typeof v.sourceLabel !== 'string' ||
    v.sourceLabel.length > 80
  )
    throw new Error('Invalid funding source. Use a label only.');
  if (typeof v.funderAddress !== 'string')
    throw new Error('Invalid funder address.');
  const funderAddress = v.funderAddress.trim()
    ? address(v.funderAddress, v.chain)
    : '';
  if (
    !Number.isSafeInteger(v.delaySeconds) ||
    v.delaySeconds < 0 ||
    v.delaySeconds > 86400
  )
    throw new Error('Delay must be a whole number from 0 to 86400 seconds.');
  const start = Date.parse(v.startAt);
  if (
    typeof v.startAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.startAt) ||
    !Number.isFinite(start) ||
    new Date(start).toISOString() !== v.startAt ||
    start < Date.UTC(2020, 0, 1) ||
    start > Date.now() + 366 * 86400000
  )
    throw new Error('Choose a valid start time within the next year.');
  if (
    !Array.isArray(v.recipients) ||
    !v.recipients.length ||
    v.recipients.length > 100
  )
    throw new Error('Add 1 to 100 recipients.');
  // Arc's native USDC uses 18 decimals in the captured chain configuration.
  const decimals =
    asset?.decimals ??
    (v.currency === 'USDC' && v.chain !== 'Arc'
      ? 6
      : v.chain === 'Solana'
        ? 9
        : 18);
  let total = 0n;
  const seen = new Set<string>();
  const recipients = v.recipients.map((r) => {
    const publicAddress = address(r?.address, v.chain);
    if (seen.has(publicAddress))
      throw new Error('Each recipient must appear once.');
    seen.add(publicAddress);
    if (
      typeof r.amount !== 'string' ||
      !/^(0|[1-9]\d{0,6})(\.\d+)?$/.test(r.amount)
    )
      throw new Error('Amounts must be positive decimal strings.');
    const [whole, fraction = ''] = r.amount.split('.');
    if (fraction.length > decimals)
      throw new Error(
        `${v.currency} supports at most ${decimals} decimal places.`,
      );
    const atoms =
      BigInt(whole) * 10n ** BigInt(decimals) +
      BigInt(fraction.padEnd(decimals, '0'));
    if (atoms <= 0n) throw new Error('Each amount must be greater than zero.');
    let proxies: string[] | undefined;
    if (r.proxies !== undefined) {
      if (
        !Array.isArray(r.proxies) ||
        r.proxies.length < 1 ||
        r.proxies.length > 3 ||
        v.chain !== 'Solana' ||
        v.currency !== 'SOL' ||
        asset
      )
        throw new Error(
          'Proxy routes take 1 to 3 wallets and native SOL only.',
        );
      proxies = r.proxies.map((p) => address(p, v.chain));
      const route = [funderAddress, ...proxies, publicAddress];
      if (!funderAddress || new Set(route).size !== route.length)
        throw new Error(
          'Proxy wallets must differ from the funder, the recipient and each other.',
        );
    }
    total += atoms;
    if (total > 1000000n * 10n ** BigInt(decimals))
      throw new Error('Total exceeds the planning limit of 1000000 units.');
    return {
      address: publicAddress,
      amount: decimal(atoms, decimals),
      ...(proxies ? { proxies } : {}),
    };
  });
  return {
    name: v.name.trim(),
    chain: v.chain,
    currency: v.currency,
    ...(asset ? { assetAddress: asset.address } : {}),
    source: v.source,
    sourceLabel: v.sourceLabel.trim(),
    funderAddress,
    startAt: v.startAt,
    delaySeconds: v.delaySeconds,
    recipients,
    total: decimal(total, decimals),
    items: recipients.map((r, i) => ({
      ...r,
      scheduledAt: new Date(start + i * v.delaySeconds * 1000).toISOString(),
    })),
  };
}
