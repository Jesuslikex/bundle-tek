import { isAddress, zeroAddress, type Address, type Hex } from 'viem';
export class PonsError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export type Intent = Readonly<{
  chainId: 4663;
  mode: 'single-recipient-atomic';
  wallet: Address;
  recipient: Address;
  creatorFeeRecipient: Address;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: Readonly<{
    twitter: string;
    telegram: string;
    discord: string;
    website: string;
    farcaster: string;
  }>;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  launchConfigId: string;
  quoteInWei: string;
  maxTotalValueWei: string;
  maxGasCostWei: string;
  minTokensOut: string;
  salt: Hex;
  snipeTaxExemptions: readonly Address[];
}>;
const fields = [
  'chainId',
  'mode',
  'wallet',
  'recipient',
  'creatorFeeRecipient',
  'name',
  'symbol',
  'logo',
  'description',
  'socials',
  'creatorTaxBps',
  'buybackEnabled',
  'launchConfigId',
  'quoteInWei',
  'maxTotalValueWei',
  'maxGasCostWei',
  'minTokensOut',
  'salt',
  'snipeTaxExemptions',
];
export function exactObject(
  x: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !x ||
    typeof x !== 'object' ||
    Array.isArray(x) ||
    Object.keys(x).length !== keys.length ||
    Object.keys(x).some((k) => !keys.includes(k))
  )
    throw new PonsError(400, 'INVALID_FIELDS');
  return x as Record<string, unknown>;
}
export function validateIntent(input: unknown): Intent {
  const x = exactObject(input, fields);
  const fail = () => {
    throw new PonsError(400, 'INVALID_INTENT');
  };
  if (x.chainId !== 4663 || x.mode !== 'single-recipient-atomic')
    throw new PonsError(400, 'UNSUPPORTED_CHAIN_OR_ALLOCATION');
  const address = (v: unknown): Address => {
    if (
      typeof v !== 'string' ||
      !isAddress(v, { strict: true }) ||
      v.toLowerCase() === zeroAddress
    )
      fail();
    return v as Address;
  };
  const str = (v: unknown, max: number, min = 0): string => {
    if (
      typeof v !== 'string' ||
      v.length < min ||
      v.length > max ||
      Array.from(v).some((char) => char.charCodeAt(0) < 32)
    )
      fail();
    return v as string;
  };
  const uint = (v: unknown, positive = false): string => {
    if (
      typeof v !== 'string' ||
      !/^(0|[1-9][0-9]{0,77})$/.test(v) ||
      BigInt(v) > 2n ** 256n - 1n ||
      (positive && BigInt(v) === 0n)
    )
      fail();
    return v as string;
  };
  const social = exactObject(x.socials, [
    'twitter',
    'telegram',
    'discord',
    'website',
    'farcaster',
  ]);
  if (
    !Number.isInteger(x.creatorTaxBps) ||
    Number(x.creatorTaxBps) < 0 ||
    Number(x.creatorTaxBps) > 65535 ||
    typeof x.buybackEnabled !== 'boolean' ||
    typeof x.salt !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(x.salt)
  )
    fail();
  if (!Array.isArray(x.snipeTaxExemptions) || x.snipeTaxExemptions.length > 32)
    fail();
  const exemptions = (x.snipeTaxExemptions as unknown[]).map(address);
  if (
    new Set(exemptions.map((a) => a.toLowerCase())).size !== exemptions.length
  )
    fail();
  return Object.freeze({
    chainId: 4663,
    mode: 'single-recipient-atomic',
    wallet: address(x.wallet),
    recipient: address(x.recipient),
    creatorFeeRecipient: address(x.creatorFeeRecipient),
    name: str(x.name, 64, 1),
    symbol: str(x.symbol, 16, 1),
    logo: str(x.logo, 512),
    description: str(x.description, 2000),
    socials: Object.freeze({
      twitter: str(social.twitter, 512),
      telegram: str(social.telegram, 512),
      discord: str(social.discord, 512),
      website: str(social.website, 512),
      farcaster: str(social.farcaster, 512),
    }),
    creatorTaxBps: x.creatorTaxBps as number,
    buybackEnabled: x.buybackEnabled as boolean,
    launchConfigId: uint(x.launchConfigId),
    quoteInWei: uint(x.quoteInWei, true),
    maxTotalValueWei: uint(x.maxTotalValueWei, true),
    maxGasCostWei: uint(x.maxGasCostWei, true),
    minTokensOut: uint(x.minTokensOut, true),
    salt: x.salt as Hex,
    snipeTaxExemptions: Object.freeze(exemptions),
  });
}
