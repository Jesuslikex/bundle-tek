import { observeTokenMarket, type TokenMarket } from './token-market';
import { inspectJitoCpmmUnsignedPacket } from './jito-cpmm-unsigned-packet';
import { readJitoCpmmAssetEvidence } from './jito-cpmm-asset-evidence';
import { snapshotJitoEvidence, awaitJitoEvidence } from './jito-evidence-json';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import bs58 from 'bs58';
const flags = {
  priceVerified: false as const,
  providerQualified: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
};
const unavailable = (reason: string) => ({
  available: false as const,
  reason,
  acknowledgementRequired: true as const,
  ...flags,
});
function decimal(v: unknown) {
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,39})(?:\.\d{1,36})?$/.test(v))
    throw Error('Unsupported price units.');
  const [whole, fraction = ''] = v.split('.'),
    n = BigInt(whole + fraction);
  if (n <= 0n) throw Error('Positive price required.');
  return { n, d: 10n ** BigInt(fraction.length) };
}
function pair(
  o: TokenMarket | null,
  mint: string,
  id: string,
  executionPool: string,
  now: number,
) {
  if (
    !o ||
    o.chain !== 'Solana' ||
    o.address !== mint ||
    o.source !== 'api.dexscreener.com' ||
    o.executionAllowed !== false ||
    !Array.isArray(o.pairs) ||
    o.pairs.length > 100 ||
    id === executionPool
  )
    return null;
  const time = Date.parse(o.observedAt);
  if (!Number.isFinite(time) || time > now || now - time > 300000) return null;
  const matches = o.pairs.filter((p) => p.address === id);
  if (matches.length !== 1) return null;
  return matches[0];
}
/** Read-only comparison against two explicitly selected external market pools.
 * Retrieval time does not attest the underlying feed's last trade timestamp.
 */
export async function readJitoCpmmPriceComparison(
  packet: Parameters<typeof inspectJitoCpmmUnsignedPacket>[0],
  selected: { inputPair: string; outputPair: string },
  minimumSlot: number,
  rpc: PumpLaunchRpc,
  signal: AbortSignal,
  dependencies: {
    observe?: typeof observeTokenMarket;
    clock?: () => number;
  } = {},
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const original = snapshotJitoEvidence(packet, 16384),
    selection = snapshotJitoEvidence(selected, 1024);
  if (!selection || Object.keys(selection).length !== 2)
    throw Error('CPMM price selection refused.');
  for (const id of [selection.inputPair, selection.outputPair]) {
    if (typeof id !== 'string' || id.length < 32 || id.length > 44)
      throw Error('CPMM price selection refused.');
    const bytes = bs58.decode(id);
    if (bytes.length !== 32 || bs58.encode(bytes) !== id)
      throw Error('CPMM price selection refused.');
  }
  const bound = await inspectJitoCpmmUnsignedPacket(original);
  if (selection.inputPair === bound.pool || selection.outputPair === bound.pool)
    return unavailable('A price from the execution pool is not independent.');
  const assets = await readJitoCpmmAssetEvidence(
    original,
    minimumSlot,
    rpc,
    signal,
  );
  const observe = dependencies.observe ?? observeTokenMarket;
  signal.throwIfAborted();
  const observations = await awaitJitoEvidence(
    signal,
    Promise.allSettled(
      [bound.inputMint, bound.outputMint].map((address) =>
        observe({ chain: 'Solana', address }, signal),
      ),
    ),
  );
  signal.throwIfAborted();
  const now = (dependencies.clock ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0)
    throw Error('CPMM price clock refused.');
  if (observations.some((o) => o.status !== 'fulfilled'))
    return unavailable('Independent market observation unavailable.');
  const input = snapshotJitoEvidence(
      (observations[0] as PromiseFulfilledResult<TokenMarket>).value,
      65536,
    ),
    output = snapshotJitoEvidence(
      (observations[1] as PromiseFulfilledResult<TokenMarket>).value,
      65536,
    );
  const a = pair(input, bound.inputMint, selection.inputPair, bound.pool, now),
    b = pair(output, bound.outputMint, selection.outputPair, bound.pool, now);
  if (!a || !b)
    return unavailable(
      'Selected independent prices are missing, stale, future-dated or in mismatched units.',
    );
  try {
    const i = decimal(a.priceUsd),
      o = decimal(b.priceUsd),
      di = assets.after.mints[0].decimals,
      doo = assets.after.mints[1].decimals;
    if (
      !Number.isInteger(di) ||
      !Number.isInteger(doo) ||
      di < 0 ||
      doo < 0 ||
      di > 18 ||
      doo > 18
    )
      throw Error();
    const inputValue = BigInt(bound.inputRaw) * i.n * o.d * 10n ** BigInt(doo),
      minimumValue =
        BigInt(bound.minimumOutputRaw) * o.n * i.d * 10n ** BigInt(di);
    const shortfall = inputValue - minimumValue;
    return {
      available: true as const,
      transactionSha256: bound.transactionSha256,
      inputMarketPair: a.address,
      outputMarketPair: b.address,
      inputPriceUsd: a.priceUsd,
      outputPriceUsd: b.priceUsd,
      inputObservedAt: input.observedAt,
      outputObservedAt: output.observedAt,
      minimumValueDifferenceBps: (
        (-shortfall * 10000n) /
        inputValue
      ).toString(),
      worse: shortfall > 0n,
      acknowledgementRequired:
        shortfall > 0n && shortfall * 10000n > inputValue * 200n,
      expiresAt: new Date(
        Math.min(Date.parse(input.observedAt), Date.parse(output.observedAt)) +
          300000,
      ).toISOString(),
      ...flags,
    };
  } catch {
    return unavailable('Independent price units cannot be compared.');
  }
}
