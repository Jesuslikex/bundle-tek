import {
  LAUNCHLAB_PROGRAM,
  STONKFUN_BASE_DECIMALS,
  STONKFUN_STANDARD_PLATFORM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  stonkAllowConfigId,
  stonkConfigId,
  stonkCurveRuleId,
} from './stonkfun-launch';

export const STONKFUN_PRICING_URL =
  'https://www.stonkfun.xyz/api/public/v1/launchlab/pricing';

export type StonkPricing = {
  quoteMint: string;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteTokenProgram: string;
  configId: string;
  platformId: string;
  supply: string;
  totalSellA: string;
  totalFundRaisingB: string;
  cpmmCreatorFeeOn: number;
  allowConfig: boolean;
  curveRuleId: string;
  startMarketCapUsd: number | null;
  graduationMarketCapUsd: number | null;
  observedAt: string;
};

const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('StonkFun pricing response differs.');
  return v as Record<string, unknown>;
};
const raw = (v: unknown, allowZero = false) => {
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(v))
    throw new Error('StonkFun pricing amount differs.');
  if (!allowZero && v === '0')
    throw new Error('StonkFun pricing amount differs.');
  return v;
};
const usd = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/**
 * Parses StonkFun's published LaunchLab pricing for one quote. Every account
 * the response names is re-derived locally; anything that is not the untaxed
 * standard platform, a constant curve with CPMM migration and no vesting is
 * refused rather than guessed.
 */
export async function parseStonkPricing(
  body: unknown,
  quoteMint: string,
): Promise<StonkPricing> {
  const data = record(record(body).data);
  const quote = record(data.quote),
    curve = record(data.curve),
    raise = record(data.raise),
    platform = record(data.platform),
    allow = record(data.allowConfig),
    allowRequired = record(allow.required),
    rule = record(data.curveRule),
    vesting = record(curve.vesting),
    prices = record(data.prices),
    marketCap = data.marketCap ? record(data.marketCap) : {};
  if (quote.mint !== quoteMint)
    throw new Error('StonkFun priced a different quote mint.');
  if (
    typeof quote.decimals !== 'number' ||
    !Number.isInteger(quote.decimals) ||
    quote.decimals < 0 ||
    quote.decimals > 12 ||
    ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(String(quote.tokenProgram))
  )
    throw new Error('StonkFun quote token details differ.');
  if (
    curve.programId !== LAUNCHLAB_PROGRAM ||
    curve.curveType !== 'ConstantCurve' ||
    curve.migrateType !== 'cpmm' ||
    curve.baseDecimals !== STONKFUN_BASE_DECIMALS ||
    raw(vesting.totalLockedAmount, true) !== '0' ||
    raw(vesting.cliffPeriod, true) !== '0' ||
    raw(vesting.unlockPeriod, true) !== '0' ||
    ![0, 1, 2].includes(Number(curve.cpmmCreatorFeeOn)) ||
    !Number.isInteger(curve.cpmmCreatorFeeOn)
  )
    throw new Error(
      'StonkFun curve shape changed. Bundle only launches the reviewed constant curve.',
    );
  const configId = await stonkConfigId(quoteMint);
  if (curve.configId !== configId)
    throw new Error('StonkFun curve config does not derive from this quote.');
  if (platform.standard !== STONKFUN_STANDARD_PLATFORM)
    throw new Error(
      'StonkFun changed its platform account. Bundle needs a reviewed update.',
    );
  const allowConfig = allowRequired.standard === true;
  if (
    allowConfig &&
    allow.standard !==
      (await stonkAllowConfigId(STONKFUN_STANDARD_PLATFORM, configId))
  )
    throw new Error('StonkFun allow-config account differs.');
  const curveRuleId = await stonkCurveRuleId(
    STONKFUN_STANDARD_PLATFORM,
    configId,
  );
  if (rule.standard !== curveRuleId)
    throw new Error('StonkFun curve-rule account differs.');
  const supply = raw(curve.supply),
    totalSellA = raw(curve.totalSellA);
  if (BigInt(totalSellA) >= BigInt(supply))
    throw new Error('StonkFun curve sale exceeds supply.');
  const observedAt =
    typeof prices.observedAt === 'string' ? prices.observedAt : '';
  if (!Number.isFinite(Date.parse(observedAt)))
    throw new Error('StonkFun pricing time differs.');
  return {
    quoteMint,
    quoteSymbol:
      typeof quote.symbol === 'string' ? quote.symbol.slice(0, 24) : '',
    quoteDecimals: quote.decimals,
    quoteTokenProgram: String(quote.tokenProgram),
    configId,
    platformId: STONKFUN_STANDARD_PLATFORM,
    supply,
    totalSellA,
    totalFundRaisingB: raw(raise.raw),
    cpmmCreatorFeeOn: Number(curve.cpmmCreatorFeeOn),
    allowConfig,
    curveRuleId,
    startMarketCapUsd: usd(marketCap.startUsd),
    graduationMarketCapUsd: usd(marketCap.graduationUsd),
    observedAt,
  };
}

export async function fetchStonkPricing(
  quoteMint: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const url = new URL(STONKFUN_PRICING_URL);
  url.searchParams.set('quoteMint', quoteMint);
  const response = await fetcher(url, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'StonkFun is rate limiting pricing. Try again in a minute.'
        : 'StonkFun pricing is unavailable for this quote.',
    );
  const text = await response.text();
  if (text.length > 200_000) throw new Error('StonkFun pricing is too large.');
  return parseStonkPricing(JSON.parse(text), quoteMint);
}
