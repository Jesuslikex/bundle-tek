import {
  address,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit-v1';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  requirePumpLaunchGroupReview,
  type PumpLaunchGroupReview,
} from './pump-launch-group-review';
import { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';
import {
  pumpHolderDigest,
  canonicalPumpHolderJson,
} from './pump-holder-review';
import {
  PUMP_NATIVE_QUOTE,
  PUMP_TOKEN_2022,
  inspectPumpQuoteMint,
} from './pump-launch-config';
import { decodePumpSigningInput } from './pump-launch-signing';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';

type Signed = Awaited<ReturnType<typeof verifyPumpLaunchGroupSignatures>>;
type Effect = {
  address: string;
  solDeltaRaw: string;
  tokenDeltaRaw: string | null;
  quoteDeltaRaw: string | null;
};
export type PumpGroupChainPacket = {
  index: number;
  signature: string;
  slot: string | null;
  outcome: 'not-observed' | 'success' | 'failed';
  networkFeeRaw: string | null;
  effectsAvailable: boolean;
  wallets: Effect[];
};
export type PumpGroupChainWallet = {
  address: string;
  role: 'deployer' | 'holder';
  knownSolDeltaRaw: string;
  knownTokenDeltaRaw: string;
  knownQuoteDeltaRaw: string;
  complete: boolean;
  targetRaw: string;
  targetKind: 'exact' | 'minimum' | 'none';
  targetStatus: 'matches' | 'differs' | 'unknown' | 'not-requested';
};
export type PumpGroupChainEffects = {
  format: 'pump-group-chain-effects-v1';
  reviewId: string;
  contextSha256: string;
  signedGroupSha256: string;
  observedAt: string;
  mint: string;
  quoteMint: string;
  quoteDecimals: number;
  packets: PumpGroupChainPacket[];
  wallets: PumpGroupChainWallet[];
  knownNetworkFeeRaw: string;
  complete: boolean;
  tipIncluded: false;
  currentHoldings: false;
  economicSettlementVerified: false;
  atomicityVerified: false;
  executionAllowed: false;
  reservationsChanged: false;
  sha256: string;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const raw = (v: unknown): string => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    throw new Error('Finalized receipt integer differs.');
  return v;
};
const index = (v: unknown, bound: number) => {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  const n = Number(raw(s));
  if (!Number.isSafeInteger(n) || n < 0 || n >= bound)
    throw new Error('Finalized receipt index differs.');
  return n;
};
const targets = (review: PumpLaunchGroupReview) => [
  {
    address: review.input.create.payer,
    role: 'deployer' as const,
    targetRaw: review.input.developer?.tokenAmountRaw ?? '0',
    targetKind: review.input.developer ? ('exact' as const) : ('none' as const),
  },
  ...review.input.holders.flatMap((h) =>
    h.kind === 'none'
      ? []
      : [
          {
            address: h.address,
            role: 'holder' as const,
            targetRaw:
              h.kind === 'exact-base-output'
                ? h.tokenAmountRaw
                : h.minimumTokenOutputRaw,
            targetKind:
              h.kind === 'exact-base-output'
                ? ('exact' as const)
                : ('minimum' as const),
          },
        ],
  ),
];
function tokenBalances(value: unknown, keys: string[]) {
  if (!Array.isArray(value)) return null;
  if (value.length > keys.length)
    throw new Error('Token receipt coverage differs.');
  const result = new Map<
    number,
    {
      mint: string;
      owner: unknown;
      program: unknown;
      decimals: number;
      amount: string;
    }
  >();
  for (const v of value) {
    if (!record(v) || !record(v.uiTokenAmount) || typeof v.mint !== 'string')
      throw new Error('Token receipt differs.');
    address(v.mint);
    const i = index(v.accountIndex, keys.length);
    if (result.has(i)) throw new Error('Duplicate token receipt index.');
    result.set(i, {
      mint: v.mint,
      owner: v.owner,
      program: v.programId,
      decimals: index(v.uiTokenAmount.decimals, 256),
      amount: raw(v.uiTokenAmount.amount),
    });
  }
  return result;
}
type TokenMap = ReturnType<typeof tokenBalances>;
function amount(
  map: TokenMap,
  keys: string[],
  balances: string[],
  ata: string,
  mint: string,
  owner: string,
  program: string,
  decimals: number,
) {
  const i = keys.indexOf(ata);
  if (i < 0) return 0n; // No address lookups: this transaction cannot write this ATA.
  if (map === null) return null;
  const entry = map.get(i);
  if (!entry) return balances[i] === '0' ? 0n : null;
  if (balances[i] === '0')
    throw new Error('Token receipt refers to a missing account.');
  if (entry.owner === undefined || entry.program === undefined) return null;
  if (
    entry.mint !== mint ||
    entry.decimals !== decimals ||
    entry.owner !== owner ||
    entry.program !== program
  )
    throw new Error('Exact token receipt custody attribution differs.');
  return BigInt(entry.amount);
}
function summarize(
  review: PumpLaunchGroupReview,
  packets: PumpGroupChainPacket[],
  native: boolean,
): PumpGroupChainWallet[] {
  return targets(review).map((t) => {
    const effects = packets.flatMap((p) =>
      p.wallets.filter((w) => w.address === t.address),
    );
    const complete =
      effects.length === packets.length &&
      packets.every(
        (p) => p.outcome !== 'not-observed' && p.effectsAvailable,
      ) &&
      effects.every(
        (w) => w.tokenDeltaRaw !== null && (native || w.quoteDeltaRaw !== null),
      );
    const sum = (field: 'solDeltaRaw' | 'tokenDeltaRaw' | 'quoteDeltaRaw') =>
      effects.reduce((s, w) => s + BigInt(w[field] ?? '0'), 0n).toString();
    const token = sum('tokenDeltaRaw');
    return {
      ...t,
      knownSolDeltaRaw: sum('solDeltaRaw'),
      knownTokenDeltaRaw: token,
      knownQuoteDeltaRaw: sum('quoteDeltaRaw'),
      complete,
      targetStatus:
        t.targetKind === 'none'
          ? 'not-requested'
          : !complete
            ? 'unknown'
            : (
                  t.targetKind === 'exact'
                    ? token === t.targetRaw
                    : BigInt(token) >= BigInt(t.targetRaw)
                )
              ? 'matches'
              : 'differs',
    };
  });
}

/** Exact finalized transaction effects, not live holdings, gross trade attribution, P&L or a release/signing authorization. */
export async function collectPumpGroupChainEffects(
  supplied: PumpLaunchGroupReview,
  suppliedSigned: Signed,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
): Promise<PumpGroupChainEffects> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const read: PumpLaunchRpc = (method, params) =>
    new Promise<unknown>((resolve, reject) => {
      const abort = () =>
        reject(new Error('Finalized wallet read was cancelled or timed out.'));
      deadline.addEventListener('abort', abort, { once: true });
      if (deadline.aborted) {
        abort();
        deadline.removeEventListener('abort', abort);
        return;
      }
      Promise.resolve()
        .then(() => {
          deadline.throwIfAborted();
          return rpc(method, params, deadline);
        })
        .then(resolve, reject)
        .finally(() => deadline.removeEventListener('abort', abort));
    });
  const { review, built } = await requirePumpLaunchGroupReview(supplied, false);
  const signed = await verifyPumpLaunchGroupSignatures(
    review,
    suppliedSigned.packets.map((p) => p.transaction),
    deadline,
  );
  if (
    canonicalPumpHolderJson(signed) !== canonicalPumpHolderJson(suppliedSigned)
  )
    throw new Error('Saved complete signature evidence differs.');
  const native = review.input.create.quoteMint === PUMP_NATIVE_QUOTE;
  const tracked = await Promise.all(
    targets(review).map(async (w) => ({
      ...w,
      base: String(
        (
          await findAssociatedTokenPda({
            owner: address(w.address),
            mint: address(review.input.create.mint),
            tokenProgram: address(PUMP_TOKEN_2022),
          })
        )[0],
      ),
      quote: native
        ? ''
        : String(
            (
              await findAssociatedTokenPda({
                owner: address(w.address),
                mint: address(review.input.create.quoteMint),
                tokenProgram: address(built.quote.tokenProgram),
              })
            )[0],
          ),
    })),
  );
  const floor = Math.max(
    review.simulation.bankSlot,
    review.simulation.maximumSlot,
    review.simulation.sourceRecheckSlot,
  );
  const mainnet = async () => {
    deadline.throwIfAborted();
    if ((await read('getGenesisHash', [], deadline)) !== SOLANA_MAINNET_GENESIS)
      throw new Error('Finalized effects provider network differs.');
  };
  await mainnet();
  const packets: PumpGroupChainPacket[] = [];
  for (const p of signed.packets) {
    deadline.throwIfAborted();
    const value = await read(
      'getTransaction',
      [
        p.signature,
        {
          encoding: 'base64',
          commitment: 'finalized',
          maxSupportedTransactionVersion: 1,
        },
      ],
      deadline,
    );
    const frame: PumpGroupChainPacket = {
      index: p.index,
      signature: p.signature,
      slot: null,
      outcome: 'not-observed',
      networkFeeRaw: null,
      effectsAvailable: false,
      wallets: [],
    };
    packets.push(frame);
    if (value === null) continue;
    if (
      !record(value) ||
      !record(value.meta) ||
      !Array.isArray(value.transaction) ||
      value.transaction.length !== 2 ||
      value.transaction[0] !== p.transaction ||
      value.transaction[1] !== 'base64' ||
      !Object.hasOwn(value.meta, 'err') ||
      value.meta.err === undefined
    )
      throw new Error('Exact finalized transaction bytes or outcome differ.');
    const slot = raw(
      typeof value.slot === 'number' && Number.isSafeInteger(value.slot)
        ? String(value.slot)
        : value.slot,
    );
    if (
      BigInt(slot) < BigInt(floor) ||
      BigInt(slot) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Finalized effects slot differs.');
    frame.slot = slot;
    frame.outcome = value.meta.err === null ? 'success' : 'failed';
    if (value.meta.fee !== undefined && value.meta.fee !== null)
      frame.networkFeeRaw = raw(value.meta.fee);
    const meta = value.meta;
    if (meta.err !== null && typeof meta.err !== 'string' && !record(meta.err))
      throw new Error('Finalized receipt outcome differs.');
    const tx = getTransactionDecoder().decode(
      Buffer.from(p.transaction, 'base64'),
    );
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    const keys = message.staticAccounts.map(String);
    if (
      keys[0] !== review.input.create.payer ||
      new Set(keys).size !== keys.length ||
      ('addressTableLookups' in message && message.addressTableLookups?.length)
    )
      throw new Error('Static effects account scope differs.');
    const loaded = meta.loadedAddresses;
    if (
      loaded !== undefined &&
      loaded !== null &&
      (!record(loaded) ||
        ['writable', 'readonly'].some(
          (k) => !Array.isArray(loaded[k]) || (loaded[k] as unknown[]).length,
        ))
    )
      throw new Error('Unexpected loaded receipt addresses.');
    if (
      !Array.isArray(meta.preBalances) ||
      !Array.isArray(meta.postBalances) ||
      meta.preBalances.length !== keys.length ||
      meta.postBalances.length !== keys.length ||
      frame.networkFeeRaw === null
    )
      continue;
    const before = meta.preBalances.map(raw),
      after = meta.postBalances.map(raw);
    if (
      before.reduce((s, v, i) => s + BigInt(v) - BigInt(after[i]), 0n) !==
      BigInt(frame.networkFeeRaw)
    )
      throw new Error('Receipt lamport conservation differs.');
    if (
      frame.outcome === 'failed' &&
      before.some(
        (v, i) =>
          BigInt(v) - BigInt(after[i]) !==
          (i === 0 ? BigInt(frame.networkFeeRaw!) : 0n),
      )
    )
      throw new Error('Failed receipt contains non-fee changes.');
    const pre = tokenBalances(meta.preTokenBalances, keys),
      post = tokenBalances(meta.postTokenBalances, keys);
    const delta = (w: (typeof tracked)[number], quote: boolean) => {
      const ata = quote ? w.quote : w.base,
        mint = quote ? review.input.create.quoteMint : review.input.create.mint;
      const program = quote ? built.quote.tokenProgram : PUMP_TOKEN_2022,
        decimals = quote
          ? built.quote.decimals
          : built.quote.createdTokenDecimals;
      const a = amount(
          pre,
          keys,
          before,
          ata,
          mint,
          w.address,
          program,
          decimals,
        ),
        b = amount(post, keys, after, ata, mint, w.address, program, decimals);
      if (a === null || b === null) return null;
      if (frame.outcome === 'failed' && a !== b)
        throw new Error('Failed receipt contains token changes.');
      return (b - a).toString();
    };
    frame.wallets = tracked.map((w) => ({
      address: w.address,
      solDeltaRaw: !keys.includes(w.address)
        ? '0'
        : (
            BigInt(after[keys.indexOf(w.address)]) -
            BigInt(before[keys.indexOf(w.address)])
          ).toString(),
      tokenDeltaRaw: delta(w, false),
      quoteDeltaRaw: native ? null : delta(w, true),
    }));
    frame.effectsAvailable = true;
  }
  await mainnet();
  const wallets = summarize(review, packets, native);
  const body = {
    format: 'pump-group-chain-effects-v1' as const,
    reviewId: review.id,
    contextSha256: review.contextSha256,
    signedGroupSha256: signed.signedGroupSha256,
    observedAt: new Date().toISOString(),
    mint: review.input.create.mint,
    quoteMint: review.input.create.quoteMint,
    quoteDecimals: built.quote.decimals,
    packets,
    wallets,
    knownNetworkFeeRaw: packets
      .reduce((s, p) => s + BigInt(p.networkFeeRaw ?? '0'), 0n)
      .toString(),
    complete: wallets.every((w) => w.complete),
    tipIncluded: false as const,
    currentHoldings: false as const,
    economicSettlementVerified: false as const,
    atomicityVerified: false as const,
    executionAllowed: false as const,
    reservationsChanged: false as const,
  };
  return { ...body, sha256: await pumpHolderDigest(body) };
}

/** Untrusted response admission for display only. No authorization flags are granted. */
export async function parsePumpGroupChainEffects(
  value: unknown,
  group: { review: PumpLaunchGroupReview; signedEvidence: Signed | null },
): Promise<PumpGroupChainEffects> {
  if (!record(value) || !group.signedEvidence)
    throw new Error('Finalized wallet result scope differs.');
  const { sha256, ...body } = value;
  const quoteDecimals =
    group.review.input.create.quoteMint === PUMP_NATIVE_QUOTE
      ? 9
      : inspectPumpQuoteMint(
          decodePumpSigningInput(group.review.input.create).quoteMintAccount!,
        ).decimals;
  if (
    value.format !== 'pump-group-chain-effects-v1' ||
    value.reviewId !== group.review.id ||
    value.contextSha256 !== group.review.contextSha256 ||
    value.signedGroupSha256 !== group.signedEvidence.signedGroupSha256 ||
    value.mint !== group.review.input.create.mint ||
    value.quoteMint !== group.review.input.create.quoteMint ||
    value.quoteDecimals !== quoteDecimals ||
    Number(value.quoteDecimals) < 0 ||
    Number(value.quoteDecimals) > 255 ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    [
      'tipIncluded',
      'currentHoldings',
      'economicSettlementVerified',
      'atomicityVerified',
      'executionAllowed',
      'reservationsChanged',
    ].some((k) => value[k] !== false) ||
    !Array.isArray(value.packets) ||
    value.packets.length !== group.review.packets.length ||
    !Array.isArray(value.wallets) ||
    value.wallets.length !== targets(group.review).length ||
    sha256 !== (await pumpHolderDigest(body))
  )
    throw new Error('Finalized wallet result scope differs.');
  const signedRaw = (v: unknown) =>
    typeof v === 'string' && /^(0|-?[1-9]\d{0,22})$/.test(v);
  const packets = value.packets as PumpGroupChainPacket[];
  for (const [i, p] of packets.entries()) {
    if (
      !record(p) ||
      p.index !== i ||
      p.signature !== group.signedEvidence.packets[i].signature ||
      !['not-observed', 'success', 'failed'].includes(p.outcome) ||
      typeof p.effectsAvailable !== 'boolean' ||
      !Array.isArray(p.wallets) ||
      p.wallets.length > value.wallets.length ||
      new Set(p.wallets.map((w) => w.address)).size !== p.wallets.length ||
      (p.slot !== null &&
        BigInt(raw(p.slot)) > BigInt(Number.MAX_SAFE_INTEGER)) ||
      (p.networkFeeRaw !== null && raw(p.networkFeeRaw) !== p.networkFeeRaw) ||
      (p.outcome === 'not-observed' &&
        (p.slot !== null ||
          p.networkFeeRaw !== null ||
          p.effectsAvailable ||
          p.wallets.length)) ||
      (p.outcome !== 'not-observed' && p.slot === null) ||
      (!p.effectsAvailable && p.wallets.length) ||
      (p.effectsAvailable && p.networkFeeRaw === null) ||
      p.wallets.some(
        (w) =>
          !record(w) ||
          !targets(group.review).some((t) => t.address === w.address) ||
          !signedRaw(w.solDeltaRaw) ||
          (w.tokenDeltaRaw !== null && !signedRaw(w.tokenDeltaRaw)) ||
          (w.quoteDeltaRaw !== null && !signedRaw(w.quoteDeltaRaw)),
      )
    )
      throw new Error('Finalized wallet result coverage differs.');
    if (
      p.effectsAvailable &&
      canonicalPumpHolderJson(p.wallets.map((w) => w.address)) !==
        canonicalPumpHolderJson(targets(group.review).map((w) => w.address))
    )
      throw new Error('Finalized wallet result participant coverage differs.');
    if (
      p.slot !== null &&
      BigInt(p.slot) <
        BigInt(
          Math.max(
            group.review.simulation.bankSlot,
            group.review.simulation.maximumSlot,
            group.review.simulation.sourceRecheckSlot,
          ),
        )
    )
      throw new Error('Finalized wallet result slot differs.');
  }
  const wallets = summarize(
    group.review,
    packets,
    value.quoteMint === PUMP_NATIVE_QUOTE,
  );
  if (
    canonicalPumpHolderJson(wallets) !==
      canonicalPumpHolderJson(value.wallets) ||
    value.complete !== wallets.every((w) => w.complete) ||
    value.knownNetworkFeeRaw !==
      packets
        .reduce((s, p) => s + BigInt(p.networkFeeRaw ?? '0'), 0n)
        .toString()
  )
    throw new Error('Finalized wallet result totals differ.');
  return value as PumpGroupChainEffects;
}
