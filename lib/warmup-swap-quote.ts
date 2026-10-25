import { PAIR_EXCLUDED_DEX_LABELS } from "./pair-trusted-programs";
import { buildWarmupPlan, warmupAtoms, warmupBuyAmount } from "./wallet-warmup";
import type { SavedWarmup } from "./wallet-warmup-storage";
import { validateTokenSource } from "./token-source";
import { solanaTokenAtoms } from "./solana-token-amount";
import { walletAddress } from "./wallet-workspace";
import { reviewUnsignedSwapOrder } from "./unsigned-swap-order";
export const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
export type QuoteErrorCode =
  | "QUOTE_UNAVAILABLE"
  | "PROVIDER_REJECTED"
  | "INVALID_RESPONSE"
  | "PARAMETER_MISMATCH"
  | "OUTPUT_PROTECTION"
  | "UNSUPPORTED_ROUTER"
  | "QUOTE_EXPIRED";
export class WarmupQuoteError extends Error {
  constructor(
    message: string,
    readonly code: QuoteErrorCode = "QUOTE_UNAVAILABLE",
    readonly providerStatus?: number,
  ) {
    super(message);
    this.name = "WarmupQuoteError";
  }
}
/**
 * The slippage ceiling this app has always used and verified against.
 *
 * The quote validator refuses any route whose minimum output is looser than
 * 50 bps below the quoted output, so 50 bps is a floor on protection rather
 * than a preference. Callers may ask for a *tighter* limit; a looser request is
 * refused outright instead of being silently clamped, because a clamp would let
 * a caller believe a trade ran tighter than it did.
 */
export const MAX_SWAP_SLIPPAGE_BPS = 50;
export function swapSlippageBps(value: unknown) {
  if (value === undefined) return MAX_SWAP_SLIPPAGE_BPS;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SWAP_SLIPPAGE_BPS
  )
    throw new WarmupQuoteError(
      `Slippage must be a whole number from 1 to ${MAX_SWAP_SLIPPAGE_BPS} bps. This app never quotes above 0.5%.`,
      "PARAMETER_MISMATCH",
    );
  return value;
}
export async function quoteWarmupBuy(
  document: SavedWarmup["document"],
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  cycle = 1,
) {
  if (document.chain !== "Solana")
    throw new WarmupQuoteError(
      "Swap quoting currently supports Solana warmup plans.",
    );
  if (!apiKey || !apiKey.trim())
    throw new WarmupQuoteError(
      "Jupiter quote service is not configured. Add JUPITER_API_KEY as a server secret.",
    );
  if (apiKey.length > 1000 || /\s/.test(apiKey))
    throw new WarmupQuoteError(
      "Jupiter quote service configuration is invalid.",
    );
  const start = Date.parse(document.startAt),
    plan = buildWarmupPlan(document, Math.min(Date.now(), start));
  if (!Number.isSafeInteger(cycle) || cycle < 1 || cycle > plan.cycles)
    throw new WarmupQuoteError("Choose a cycle in the saved warmup plan.");
  const outputMint = plan.tokens[(cycle - 1) % plan.tokens.length];
  if (outputMint === WRAPPED_SOL)
    throw new WarmupQuoteError(
      "Choose a token other than wrapped SOL for a SOL swap.",
    );
  // Range plans preview the first wallet's reviewed amount for this cycle.
  const amount = warmupAtoms(
    warmupBuyAmount(document, plan.addresses[0], cycle),
    9,
  );
  if (amount > (1n << 64n) - 1n)
    throw new WarmupQuoteError("Swap amount exceeds Solana limits.");
  // Match the executable warmup path instead of receiving an RFQ quote with
  // different slippage semantics. Keep the response's exact-parameter checks.
  const quote = await quoteSolanaSwap(
    {
      tokenMint: outputMint,
      amountRaw: amount.toString(),
      side: "Buy",
      metisOnly: true,
    },
    apiKey,
    signal,
    fetcher,
  );
  return {
    ...quote,
    side: "Buy" as const,
    cycle,
    limitations: "Selected cycle buy only. " + quote.limitations,
  };
}
export async function quoteSolanaBuy(
  input: { outputMint: string; amount: string },
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const quote = await quoteSolanaSwap(
    {
      tokenMint: input.outputMint,
      amountRaw: warmupAtoms(input.amount, 9).toString(),
      side: "Buy",
    },
    apiKey,
    signal,
    fetcher,
  );
  return { ...quote, side: "Buy" as const };
}
export async function quoteSolanaSell(
  input: { inputMint: string; amount: string; decimals: number },
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const quote = await quoteSolanaSwap(
    {
      tokenMint: input.inputMint,
      amountRaw: solanaTokenAtoms(input.amount, input.decimals).toString(),
      side: "Sell",
    },
    apiKey,
    signal,
    fetcher,
  );
  return { ...quote, side: "Sell" as const };
}
async function quoteSolanaSwap(
  input: {
    tokenMint: string;
    amountRaw: string;
    side: "Buy" | "Sell";
    taker?: string;
    quoteMint?: string;
    metisOnly?: true;
    /** Metis-only DEX labels to skip; also excludes the non-Metis routers. */
    excludeDexes?: readonly string[];
    /** Tighten-only: 1..50 bps. Absent keeps the 50 bps bound. */
    slippageBps?: number;
  },
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  const { address: outputMint } = validateTokenSource({
    chain: "Solana",
    address: input.tokenMint,
  });
  const slippage = swapSlippageBps(input.slippageBps);
  const quoteMint = validateTokenSource({
    chain: "Solana",
    address: input.quoteMint ?? WRAPPED_SOL,
  }).address;
  if (
    !["Buy", "Sell"].includes(input.side) ||
    !/^[1-9]\d{0,19}$/.test(input.amountRaw)
  )
    throw new WarmupQuoteError(
      "Choose an exact positive input amount in token atomic units.",
    );
  const amount = BigInt(input.amountRaw);
  if (outputMint === quoteMint || amount > (1n << 64n) - 1n)
    throw new WarmupQuoteError(
      "Choose a distinct token and an amount within Solana limits.",
    );
  if (!apiKey || !apiKey.trim() || apiKey.length > 1000 || /\s/.test(apiKey))
    throw new WarmupQuoteError(
      "Jupiter quote service is not configured or has invalid configuration.",
    );
  const inputMint = input.side === "Buy" ? quoteMint : outputMint;
  const destinationMint = input.side === "Buy" ? outputMint : quoteMint;
  const url = new URL("https://api.jup.ag/swap/v2/order");
  url.search = new URLSearchParams({
    inputMint,
    outputMint: destinationMint,
    amount: amount.toString(),
    swapMode: "ExactIn",
    slippageBps: String(slippage),
    ...(input.taker || input.metisOnly || input.excludeDexes
      ? { excludeRouters: "jupiterz,dflow,okx" }
      : {}),
    ...(input.excludeDexes?.length
      ? { excludeDexes: input.excludeDexes.join(",") }
      : {}),
    ...(input.taker
      ? {
          taker: input.taker,
          maxSupportedTransactionVersion: "0",
        }
      : {}),
  }).toString();
  const response = await fetcher(url, {
    headers: { "x-api-key": apiKey },
    signal,
    redirect: "manual",
    cache: "no-store",
  });
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new WarmupQuoteError(
      response.status === 401 || response.status === 403
        ? "Jupiter quote service authentication failed."
        : response.status === 429
          ? "Jupiter quote service rate limit reached. Retry later."
          : response.status === 400 && input.taker
            ? "Jupiter could not prepare this wallet order. Check warmup preflight, the input balance and SOL for fees and account rent. A market quote does not establish wallet readiness."
            : "Jupiter quote service unavailable or no route found.",
      response.status === 400 && input.taker
        ? "PROVIDER_REJECTED"
        : "QUOTE_UNAVAILABLE",
      response.status,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WarmupQuoteError("Empty quote response.");
  let text = "",
    size = 0;
  const decoder = new TextDecoder();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > 262144) {
        cancel();
        throw new WarmupQuoteError("Quote response exceeds the size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    data = parsed as Record<string, unknown>;
  } catch {
    throw new WarmupQuoteError(
      "Quote service returned an invalid response. Request a fresh quote.",
      "INVALID_RESPONSE",
    );
  }
  if (data.error || data.errorCode !== undefined)
    throw new WarmupQuoteError(
      "Quote provider rejected this request. Request a fresh quote; a route may be unavailable.",
      "PROVIDER_REJECTED",
    );
  const atoms = (v: unknown) => {
    if (
      typeof v !== "string" ||
      !/^[1-9]\d{0,19}$/.test(v) ||
      BigInt(v) > (1n << 64n) - 1n
    )
      throw new WarmupQuoteError("Invalid quote amount.");
    return BigInt(v);
  };
  if (
    data.inputMint !== inputMint ||
    data.outputMint !== destinationMint ||
    atoms(data.inAmount) !== amount ||
    data.swapMode !== "ExactIn" ||
    data.slippageBps !== slippage
  )
    throw new WarmupQuoteError(
      "Quote parameters do not match the requested swap.",
      "PARAMETER_MISMATCH",
    );
  const output = atoms(data.outAmount),
    minimum = atoms(data.otherAmountThreshold);
  let platformFee: { bps: number; mint: string } | undefined;
  if (data.platformFee !== undefined && data.platformFee !== null) {
    const fee = data.platformFee as { feeBps?: unknown; feeMint?: unknown };
    if (
      !Number.isSafeInteger(fee.feeBps) ||
      Number(fee.feeBps) < 0 ||
      Number(fee.feeBps) > 10000 ||
      typeof fee.feeMint !== "string" ||
      ![inputMint, destinationMint].includes(fee.feeMint) ||
      (data.feeBps !== undefined && data.feeBps !== fee.feeBps) ||
      (data.feeMint !== undefined && data.feeMint !== fee.feeMint)
    )
      throw new WarmupQuoteError(
        "Unsupported or inconsistent quote platform fee.",
      );
    platformFee = { bps: Number(fee.feeBps), mint: fee.feeMint };
  } else if (data.feeBps !== undefined && data.feeBps !== 0)
    throw new WarmupQuoteError("Missing quote platform fee metadata.");
  if (
    minimum > output ||
    minimum < (output * BigInt(10000 - slippage)) / 10000n
  )
    throw new WarmupQuoteError(
      "Quote output protection failed validation. Request a fresh quote.",
      "OUTPUT_PROTECTION",
    );
  if (
    typeof data.router !== "string" ||
    !["metis", "jupiterz", "dflow", "okx"].includes(data.router)
  )
    throw new WarmupQuoteError(
      "Quote router is unsupported. Request a fresh quote from a supported route.",
      "UNSUPPORTED_ROUTER",
    );
  if ((input.taker || input.metisOnly) && data.router !== "metis")
    throw new WarmupQuoteError(
      "Pair quotes and wallet-bound preparations require the supported Metis router.",
      "UNSUPPORTED_ROUTER",
    );
  let expiry = Date.now() + 30000;
  if (data.expireAt !== undefined) {
    if (
      typeof data.expireAt !== "string" ||
      !Number.isFinite(Date.parse(data.expireAt)) ||
      Date.parse(data.expireAt) <= Date.now()
    )
      throw new WarmupQuoteError(
        "Provider quote has expired. Request a fresh quote.",
        "QUOTE_EXPIRED",
      );
    expiry = Math.min(expiry, Date.parse(data.expireAt));
  }
  // Quote-only calls discard transaction material; wallet-bound preparation inspects it.
  const preparation = input.taker
    ? await reviewUnsignedSwapOrder(data, input.taker)
    : undefined;
  return {
    executionAllowed: false as const,
    side: input.side,
    inputMint,
    outputMint: destinationMint,
    inAmount: amount.toString(),
    outAmount: output.toString(),
    minimumOutAmount: minimum.toString(),
    slippageBps: slippage,
    router: data.router,
    ...(input.taker && data.priceImpactPct !== undefined
      ? { priceImpactPct: validOrderPriceImpact(data.priceImpactPct) }
      : {}),
    ...(platformFee ? { platformFee } : {}),
    source: "api.jup.ag",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(expiry).toISOString(),
    ...(preparation ? { preparation } : {}),
    limitations: preparation
      ? "Wallet-bound unsigned order. No signature or execute request. Provider fee estimates and swap semantics require independent review."
      : "Quote in token atomic units. No wallet, transaction, signature or execute request. Fees, token restrictions and wallet-specific eligibility are not verified. Sell amounts require actual acquired-token balances.",
  };
}
export async function prepareSolanaSwap(
  input: {
    tokenMint: string;
    side: "Buy" | "Sell";
    amount: string;
    decimals: number;
    wallet: string;
    /** Tighten-only: 1..50 bps. Absent keeps the 50 bps bound. */
    slippageBps?: number;
  },
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const taker = walletAddress(input.wallet, "Solana");
  const amountRaw = (
    input.side === "Buy"
      ? warmupAtoms(input.amount, 9)
      : solanaTokenAtoms(input.amount, input.decimals)
  ).toString();
  const order = await quoteSolanaSwap(
    {
      tokenMint: input.tokenMint,
      side: input.side,
      amountRaw,
      taker,
      // Validate here so the caller's value is refused before any provider call.
      slippageBps: swapSlippageBps(input.slippageBps),
    },
    apiKey,
    signal,
    fetcher,
  );
  if (!order.preparation)
    throw new WarmupQuoteError("Unsigned swap preparation unavailable.");
  return { ...order, preparation: order.preparation };
}
/** Quote-only pair endpoint. No taker, wallet, transaction or signing permission. */
export async function quoteSolanaPair(
  input: {
    baseMint: string;
    quoteMint: string;
    amountRaw: string;
    side: "Buy" | "Sell";
  },
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const quoteMint = validateTokenSource({
    chain: "Solana",
    address: input.quoteMint,
  }).address;
  return quoteSolanaSwap(
    {
      tokenMint: input.baseMint,
      quoteMint,
      amountRaw: input.amountRaw,
      side: input.side,
      metisOnly: true,
    },
    apiKey,
    signal,
    fetcher,
  );
}
/** Wallet-bound candidate only. Asset precision and funding must be independently observed. */
export async function prepareSolanaPair(
  input: Parameters<typeof quoteSolanaPair>[0] & { wallet: string },
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const taker = walletAddress(input.wallet, "Solana");
  const order = await quoteSolanaSwap(
    {
      tokenMint: input.baseMint,
      quoteMint: input.quoteMint,
      amountRaw: input.amountRaw,
      side: input.side,
      taker,
      // Route only through pinned programs; the code-scan pin check still decides.
      excludeDexes: PAIR_EXCLUDED_DEX_LABELS,
    },
    apiKey,
    signal,
    fetcher,
  );
  if (!order.preparation)
    throw new WarmupQuoteError("Unsigned pair preparation unavailable.");
  return { ...order, preparation: order.preparation };
}
export type SolanaPairPreparation = Awaited<
  ReturnType<typeof prepareSolanaPair>
>;
/** Preserve only bounded provider estimates. Never silently present missing impact as zero. */
function validOrderPriceImpact(value: unknown): string {
  const text =
    typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || !/^-?\d{1,3}(?:\.\d{1,60})?$/.test(text))
    throw new WarmupQuoteError("Invalid order price impact estimate.");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  if (
    BigInt(whole) > 100n ||
    (BigInt(whole) === 100n && /[1-9]/.test(fraction))
  )
    throw new WarmupQuoteError("Invalid order price impact estimate.");
  return text;
}
export type SolanaSwapPreparation = Awaited<
  ReturnType<typeof prepareSolanaSwap>
>;
export type WarmupSwapQuote = Awaited<ReturnType<typeof quoteWarmupBuy>>;
export type SolanaBuyQuote = Awaited<ReturnType<typeof quoteSolanaBuy>>;
export type SolanaSwapQuote =
  | SolanaBuyQuote
  | Awaited<ReturnType<typeof quoteSolanaSell>>;
