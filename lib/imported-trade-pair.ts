import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import {
  supportedSwapTokenProgram,
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
} from './swap-token-program-evidence';
import {
  pairUiAtoms,
  pairUiAmount,
  validPairAmountPolicy,
  activePairMultiplier,
  pairAmountLifetimeMs,
  type PairAmountPolicy,
} from './pair-ui-amount';
import {
  PAIR_QUOTE_EXTENSIONS,
  PAIR_ISSUER_CONTROLS,
  type PairIssuerControl,
} from './pair-mint-evidence';
import type { quoteSolanaPair } from './warmup-swap-quote';
export type ImportedPairAsset = {
  address: string;
  symbol: string;
  decimals: number;
  program: string;
  amountPolicy: PairAmountPolicy;
  extensions: string[];
  issuerControls: PairIssuerControl[];
};
export type ImportedTradePair = {
  format: 'imported-trade-pair-v2';
  projectId: string;
  projectRevision: number;
  projectDocumentSha256: string;
  chain: 'Solana';
  network: 'mainnet';
  base: ImportedPairAsset;
  quote: ImportedPairAsset;
  catalogSnapshot: '2026-10-09';
  issuerVerified: false;
  mintPolicy: {
    slot: number;
    recheckSlot: number;
    baseSha256: string;
    quoteSha256: string;
    unixTimestamp: string;
    recheckUnixTimestamp: string;
  };
  observedAt: string;
  expiresAt: string;
  sha256: string;
};
export type ImportedPairQuote = {
  format: 'imported-pair-quote-v2';
  pair: ImportedTradePair;
  side: 'Buy' | 'Sell';
  inputRaw: string;
  requestedInputAmount: string;
  inputRounding: 'conservative-down-v1';
  inputAmount: string;
  outputAmount: string;
  minimumOutputAmount: string;
  quote: Awaited<ReturnType<typeof quoteSolanaPair>>;
  signingAllowed: false;
  executionAllowed: false;
  balancesChecked: false;
};
export type ImportedPairQuoteSelection = {
  projectId: string;
  projectRevision: number;
  baseMint: string;
  baseDecimals: number;
  baseSymbol: string;
  quoteMint: string;
  quoteDecimals: number;
  quoteSymbol: string;
  side: 'Buy' | 'Sell';
  amount: string;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) =>
  Object.keys(v).sort().join(',') === [...fields].sort().join(',');
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const date = (v: unknown) =>
  typeof v === 'string' && v.length <= 32 && Number.isFinite(Date.parse(v));
const uint = (v: unknown) =>
  typeof v === 'string' &&
  /^[1-9]\d{0,19}$/.test(v) &&
  BigInt(v) <= (1n << 64n) - 1n;
export async function importedPairSha256(
  value: Omit<ImportedTradePair, 'sha256'>,
) {
  const asset = (a: ImportedPairAsset) => [
    a.address,
    a.symbol,
    a.decimals,
    a.program,
    a.amountPolicy.kind === 'unscaled'
      ? ['unscaled']
      : [
          a.amountPolicy.kind,
          a.amountPolicy.multiplierHex,
          a.amountPolicy.nextMultiplierHex,
          a.amountPolicy.effectiveTimestamp,
        ],
    a.extensions,
    a.issuerControls,
  ];
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      value.format,
      value.projectId,
      value.projectRevision,
      value.projectDocumentSha256,
      value.chain,
      value.network,
      asset(value.base),
      asset(value.quote),
      value.catalogSnapshot,
      value.issuerVerified,
      [
        value.mintPolicy.slot,
        value.mintPolicy.recheckSlot,
        value.mintPolicy.baseSha256,
        value.mintPolicy.quoteSha256,
        value.mintPolicy.unixTimestamp,
        value.mintPolicy.recheckUnixTimestamp,
      ],
      value.observedAt,
      value.expiresAt,
    ]),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
/** A public observation fingerprint, never a wallet authorization or issuer attestation. */
export async function parseImportedTradePair(
  value: unknown,
): Promise<ImportedTradePair> {
  const fail = (): never => {
    throw new Error(
      'Trade pair identity differs. Refresh the current token and exact quote asset.',
    );
  };
  if (
    !object(value) ||
    !exact(value, [
      'format',
      'projectId',
      'projectRevision',
      'projectDocumentSha256',
      'chain',
      'network',
      'base',
      'quote',
      'catalogSnapshot',
      'issuerVerified',
      'mintPolicy',
      'observedAt',
      'expiresAt',
      'sha256',
    ]) ||
    value.format !== 'imported-trade-pair-v2' ||
    typeof value.projectId !== 'string' ||
    !UUID.test(value.projectId) ||
    !Number.isSafeInteger(value.projectRevision) ||
    Number(value.projectRevision) < 1 ||
    Number(value.projectRevision) > 1e9 ||
    !hash(value.projectDocumentSha256) ||
    value.chain !== 'Solana' ||
    value.network !== 'mainnet' ||
    value.catalogSnapshot !== '2026-10-09' ||
    value.issuerVerified !== false ||
    !hash(value.sha256) ||
    !date(value.observedAt) ||
    !date(value.expiresAt)
  )
    return fail();
  for (const asset of [value.base, value.quote]) {
    if (
      !object(asset) ||
      !exact(asset, [
        'address',
        'symbol',
        'decimals',
        'program',
        'amountPolicy',
        'extensions',
        'issuerControls',
      ]) ||
      typeof asset.symbol !== 'string' ||
      !asset.symbol.trim() ||
      asset.symbol.length > 64 ||
      !Number.isInteger(asset.decimals) ||
      Number(asset.decimals) < 0 ||
      Number(asset.decimals) > 18 ||
      !supportedSwapTokenProgram(asset.program) ||
      !validPairAmountPolicy(asset.amountPolicy) ||
      !Array.isArray(asset.extensions) ||
      asset.extensions.some(
        (e) => !(PAIR_QUOTE_EXTENSIONS as readonly unknown[]).includes(e),
      ) ||
      new Set(asset.extensions).size !== asset.extensions.length ||
      asset.extensions.join(',') !==
        asset.extensions.map(String).sort().join(',') ||
      !Array.isArray(asset.issuerControls) ||
      asset.issuerControls.some(
        (e) => !(PAIR_ISSUER_CONTROLS as readonly unknown[]).includes(e),
      ) ||
      new Set(asset.issuerControls).size !== asset.issuerControls.length ||
      asset.issuerControls.join(',') !==
        asset.issuerControls.map(String).sort().join(',') ||
      (asset.program === SWAP_TOKEN &&
        (asset.extensions.length > 0 ||
          asset.issuerControls.some(
            (e) => !['mintable', 'freezable'].includes(e),
          ))) ||
      (asset.amountPolicy.kind === 'scaled-ui-v1' &&
        asset.program !== SWAP_TOKEN_2022) ||
      asset.extensions.includes('ScaledUiAmountConfig') !==
        (asset.amountPolicy.kind === 'scaled-ui-v1')
    )
      return fail();
    try {
      walletAddress(asset.address, 'Solana');
    } catch {
      return fail();
    }
  }
  if (
    (value.base as Record<string, unknown>).address ===
    (value.quote as Record<string, unknown>).address
  )
    return fail();
  const policy = value.mintPolicy;
  if (
    !object(policy) ||
    !exact(policy, [
      'slot',
      'recheckSlot',
      'baseSha256',
      'quoteSha256',
      'unixTimestamp',
      'recheckUnixTimestamp',
    ]) ||
    !Number.isSafeInteger(policy.slot) ||
    Number(policy.slot) < 1 ||
    !Number.isSafeInteger(policy.recheckSlot) ||
    Number(policy.recheckSlot) < Number(policy.slot) ||
    Number(policy.recheckSlot) > Number(policy.slot) + 32 ||
    !hash(policy.baseSha256) ||
    !hash(policy.quoteSha256) ||
    typeof policy.unixTimestamp !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(policy.unixTimestamp) ||
    typeof policy.recheckUnixTimestamp !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(policy.recheckUnixTimestamp) ||
    !Number.isSafeInteger(Number(policy.unixTimestamp)) ||
    !Number.isSafeInteger(Number(policy.recheckUnixTimestamp)) ||
    BigInt(policy.recheckUnixTimestamp) < BigInt(policy.unixTimestamp) ||
    BigInt(policy.recheckUnixTimestamp) > BigInt(policy.unixTimestamp) + 60n ||
    Math.abs(
      Number(policy.unixTimestamp) * 1000 -
        Date.parse(String(value.observedAt)),
    ) > 30000 ||
    Math.abs(
      Number(policy.recheckUnixTimestamp) * 1000 -
        Date.parse(String(value.observedAt)),
    ) > 30000
  )
    return fail();
  const pair = value as unknown as ImportedTradePair;
  for (const a of [pair.base, pair.quote]) {
    if (
      activePairMultiplier(a.amountPolicy, policy.unixTimestamp) !==
      activePairMultiplier(a.amountPolicy, policy.recheckUnixTimestamp)
    )
      return fail();
    for (const [control, extension] of [
      ['pausable', 'PausableConfig'],
      ['permanent-delegate', 'PermanentDelegate'],
      ['transfer-hook-upgradable', 'TransferHook'],
      ['ui-multiplier-upgradable', 'ScaledUiAmountConfig'],
    ] as const)
      if (
        a.issuerControls.includes(control) &&
        !a.extensions.includes(extension)
      )
        return fail();
  }
  const lifetime = pairAmountLifetimeMs(
    [pair.base.amountPolicy, pair.quote.amountPolicy],
    pair.mintPolicy.recheckUnixTimestamp,
    Date.parse(pair.observedAt),
  );
  if (
    lifetime < 1 ||
    Date.parse(pair.expiresAt) !== Date.parse(pair.observedAt) + lifetime
  )
    return fail();
  if ((await importedPairSha256(pair)) !== pair.sha256) return fail();
  return structuredClone(pair);
}
export async function parseImportedPairQuote(
  value: unknown,
  expected: ImportedPairQuoteSelection,
  now = Date.now(),
): Promise<ImportedPairQuote> {
  const fail = (): never => {
    throw new Error(
      'Pair quote differs from the selected assets, amount or current project. Request a fresh quote.',
    );
  };
  if (
    !object(value) ||
    !exact(value, [
      'format',
      'pair',
      'side',
      'inputRaw',
      'requestedInputAmount',
      'inputRounding',
      'inputAmount',
      'outputAmount',
      'minimumOutputAmount',
      'quote',
      'signingAllowed',
      'executionAllowed',
      'balancesChecked',
    ]) ||
    value.format !== 'imported-pair-quote-v2' ||
    !['Buy', 'Sell'].includes(String(value.side)) ||
    value.requestedInputAmount !== expected.amount ||
    value.inputRounding !== 'conservative-down-v1' ||
    value.side !== expected.side ||
    value.signingAllowed !== false ||
    value.executionAllowed !== false ||
    value.balancesChecked !== false
  )
    return fail();
  const pair = await parseImportedTradePair(value.pair);
  if (
    pair.projectId !== expected.projectId ||
    pair.projectRevision !== expected.projectRevision ||
    pair.base.address !== expected.baseMint ||
    pair.base.decimals !== expected.baseDecimals ||
    pair.base.symbol !== expected.baseSymbol ||
    pair.quote.address !== expected.quoteMint ||
    pair.quote.decimals !== expected.quoteDecimals ||
    pair.quote.symbol !== expected.quoteSymbol ||
    Date.parse(pair.observedAt) > now + 1000 ||
    Date.parse(pair.expiresAt) <= now
  )
    return fail();
  const input = expected.side === 'Buy' ? pair.quote : pair.base,
    output = expected.side === 'Buy' ? pair.base : pair.quote;
  const clock = pair.mintPolicy.recheckUnixTimestamp;
  const raw = pairUiAtoms(
      expected.amount,
      input.decimals,
      input.amountPolicy,
      clock,
    ).toString(),
    quote = value.quote;
  if (
    !object(quote) ||
    'preparation' in quote ||
    'transaction' in quote ||
    quote.executionAllowed !== false ||
    quote.side !== expected.side ||
    quote.inputMint !== input.address ||
    quote.outputMint !== output.address ||
    quote.inAmount !== raw ||
    value.inputRaw !== raw ||
    !uint(quote.outAmount) ||
    !uint(quote.minimumOutAmount) ||
    quote.slippageBps !== 50 ||
    !['metis', 'jupiterz', 'dflow', 'okx'].includes(String(quote.router)) ||
    quote.source !== 'api.jup.ag' ||
    !date(quote.observedAt) ||
    !date(quote.expiresAt) ||
    Date.parse(String(quote.observedAt)) < Date.parse(pair.observedAt) ||
    Date.parse(String(quote.observedAt)) > now + 1000 ||
    Date.parse(String(quote.expiresAt)) <= now ||
    Date.parse(String(quote.expiresAt)) <=
      Date.parse(String(quote.observedAt)) ||
    Date.parse(String(quote.expiresAt)) > Date.parse(pair.expiresAt) ||
    BigInt(String(quote.minimumOutAmount)) > BigInt(String(quote.outAmount)) ||
    BigInt(String(quote.minimumOutAmount)) <
      (BigInt(String(quote.outAmount)) * 9950n) / 10000n ||
    value.inputAmount !==
      pairUiAmount(raw, input.decimals, input.amountPolicy, clock) ||
    value.outputAmount !==
      pairUiAmount(
        String(quote.outAmount),
        output.decimals,
        output.amountPolicy,
        clock,
      ) ||
    value.minimumOutputAmount !==
      pairUiAmount(
        String(quote.minimumOutAmount),
        output.decimals,
        output.amountPolicy,
        clock,
      )
  )
    return fail();
  if (
    !exact(quote, [
      'executionAllowed',
      'side',
      'inputMint',
      'outputMint',
      'inAmount',
      'outAmount',
      'minimumOutAmount',
      'slippageBps',
      'router',
      'source',
      'observedAt',
      'expiresAt',
      'limitations',
      ...(quote.platformFee === undefined ? [] : ['platformFee']),
    ]) ||
    typeof quote.limitations !== 'string' ||
    !quote.limitations ||
    quote.limitations.length > 2048
  )
    return fail();
  if (quote.platformFee !== undefined) {
    const fee = quote.platformFee;
    if (
      !object(fee) ||
      !exact(fee, ['bps', 'mint']) ||
      !Number.isInteger(fee.bps) ||
      Number(fee.bps) < 0 ||
      Number(fee.bps) > 10000 ||
      ![input.address, output.address].includes(String(fee.mint))
    )
      return fail();
  }
  return structuredClone(value as unknown as ImportedPairQuote);
}
