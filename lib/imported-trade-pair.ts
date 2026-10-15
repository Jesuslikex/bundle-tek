import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';
import { supportedSwapTokenProgram } from './swap-token-program-evidence';
import type { quoteSolanaPair } from './warmup-swap-quote';
export type ImportedTradePair = {
  format: 'imported-trade-pair-v1';
  projectId: string;
  projectRevision: number;
  projectDocumentSha256: string;
  chain: 'Solana';
  network: 'mainnet';
  base: { address: string; symbol: string; decimals: number; program: string };
  quote: { address: string; symbol: string; decimals: number; program: string };
  catalogSnapshot: '2026-10-09';
  issuerVerified: false;
  mintPolicy: {
    slot: number;
    recheckSlot: number;
    baseSha256: string;
    quoteSha256: string;
  };
  observedAt: string;
  expiresAt: string;
  sha256: string;
};
export type ImportedPairQuote = {
  format: 'imported-pair-quote-v1';
  pair: ImportedTradePair;
  side: 'Buy' | 'Sell';
  inputRaw: string;
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
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      value.format,
      value.projectId,
      value.projectRevision,
      value.projectDocumentSha256,
      value.chain,
      value.network,
      [
        value.base.address,
        value.base.symbol,
        value.base.decimals,
        value.base.program,
      ],
      [
        value.quote.address,
        value.quote.symbol,
        value.quote.decimals,
        value.quote.program,
      ],
      value.catalogSnapshot,
      value.issuerVerified,
      [
        value.mintPolicy.slot,
        value.mintPolicy.recheckSlot,
        value.mintPolicy.baseSha256,
        value.mintPolicy.quoteSha256,
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
    value.format !== 'imported-trade-pair-v1' ||
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
    !date(value.expiresAt) ||
    Date.parse(String(value.expiresAt)) !==
      Date.parse(String(value.observedAt)) + 30000
  )
    return fail();
  for (const asset of [value.base, value.quote]) {
    if (
      !object(asset) ||
      !exact(asset, ['address', 'symbol', 'decimals', 'program']) ||
      typeof asset.symbol !== 'string' ||
      !asset.symbol.trim() ||
      asset.symbol.length > 64 ||
      !Number.isInteger(asset.decimals) ||
      Number(asset.decimals) < 0 ||
      Number(asset.decimals) > 18 ||
      !supportedSwapTokenProgram(asset.program)
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
    !exact(policy, ['slot', 'recheckSlot', 'baseSha256', 'quoteSha256']) ||
    !Number.isSafeInteger(policy.slot) ||
    Number(policy.slot) < 1 ||
    !Number.isSafeInteger(policy.recheckSlot) ||
    Number(policy.recheckSlot) < Number(policy.slot) ||
    Number(policy.recheckSlot) > Number(policy.slot) + 32 ||
    !hash(policy.baseSha256) ||
    !hash(policy.quoteSha256)
  )
    return fail();
  const pair = value as unknown as ImportedTradePair;
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
      'inputAmount',
      'outputAmount',
      'minimumOutputAmount',
      'quote',
      'signingAllowed',
      'executionAllowed',
      'balancesChecked',
    ]) ||
    value.format !== 'imported-pair-quote-v1' ||
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
  const raw = solanaTokenAtoms(expected.amount, input.decimals).toString(),
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
    value.inputAmount !== formatNativeBalance(raw, input.decimals) ||
    value.outputAmount !==
      formatNativeBalance(String(quote.outAmount), output.decimals) ||
    value.minimumOutputAmount !==
      formatNativeBalance(String(quote.minimumOutAmount), output.decimals)
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
