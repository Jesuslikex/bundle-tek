import { z } from 'zod';
import { address } from '@solana/kit';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  warmupExecutionId as uuid,
  warmupExecutionHash as hash,
  warmupExecutionUnits as units,
  warmupExecutionTimestamp as iso,
} from './wallet-warmup-execution-manifest';
import {
  inspectSwapMintAccount,
  assertSameSwapMintEvidence,
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
  SWAP_TOKEN_2022_ACCOUNT_SIZE,
} from './swap-token-program-evidence';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';
import { PAIR_CLOCK, pairClockUnixTimestamp } from './pair-stock-clock';
import { requireConsistentSolanaSlots } from './solana-rpc';

const key = z
  .string()
  .min(32)
  .max(44)
  .refine((v) => {
    try {
      address(v);
      return true;
    } catch {
      return false;
    }
  });
const slot = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const owner = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const provider = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => {
    try {
      const u = new URL('https://' + v);
      return (
        u.hostname === v &&
        !u.username &&
        !u.password &&
        u.pathname === '/' &&
        !u.search &&
        !u.hash
      );
    } catch {
      return false;
    }
  });
const mint = z
  .object({
    address: key,
    program: z.enum([SWAP_TOKEN, SWAP_TOKEN_2022]),
    decimals: z.number().int().min(0).max(18),
    policySha256: hash,
  })
  .strict();
const rawAccount = z
  .object({
    owner: key,
    executable: z.literal(false),
    data: z.tuple([z.string().max(21848), z.literal('base64')]),
    lamports: units.optional(),
    space: z.literal('17').optional(),
  })
  .strict();
const rent = z
  .object({
    lamportsPerByte: units,
    exemptionThreshold: z.union([z.literal(1), z.literal(2)]),
    burnPercent: z.number().int().min(0).max(100),
    dataBase64: z.string().length(24),
  })
  .strict();
const observation = z
  .object({
    slot,
    unixTimestamp: z.string().regex(/^[1-9]\d{0,15}$/),
    evaluatedServerAt: iso,
    rent,
    mints: z.array(mint).min(2).max(11),
    accounts: z
      .array(z.object({ address: key, account: rawAccount }).strict())
      .min(4)
      .max(13),
  })
  .strict();
/** Shape capture only; decoding/integrity still requires replay and owned selectors. */
export const warmupExecutionAssetEvidenceSchema = z
  .object({
    format: z.literal('wallet-warmup-execution-assets-v1'),
    ownerId: owner,
    reviewId: uuid,
    reviewSha256: hash,
    sourceSnapshotSha256: hash,
    provider,
    network: z.literal('mainnet'),
    commitment: z.literal('confirmed'),
    floorSlot: slot,
    before: observation,
    after: observation,
    tokenAccountRents: z
      .array(
        mint
          .extend({
            accountSize: z.union([z.literal(165), z.literal(170)]),
            minimumRentLamports: units.refine((v) => BigInt(v) > 0n),
          })
          .strict(),
      )
      .min(2)
      .max(11),
    checkedAt: iso,
    expiresAt: iso,
    scope: z.literal('mint-policy-and-token-account-rent-only'),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
    automaticExecutionAllowed: z.literal(false),
  })
  .strict();
const packet = z
  .object({
    evidence: warmupExecutionAssetEvidenceSchema,
    evidenceSha256: hash,
  })
  .strict();
const expectedSchema = z
  .object({
    ownerId: owner,
    reviewId: uuid,
    reviewSha256: hash,
    sourceSnapshotSha256: hash,
    evidenceSha256: hash,
    provider,
    mints: z.array(key).min(1).max(10),
    reviewedAt: iso,
    reviewExpiresAt: iso,
    expiresAt: iso,
  })
  .strict();

export class WarmupExecutionAssetReplayError extends Error {
  constructor() {
    super(
      'Retained warmup asset evidence is incomplete or differs from its owned record.',
    );
    this.name = 'WarmupExecutionAssetReplayError';
  }
}
const fail = (): never => {
  throw new WarmupExecutionAssetReplayError();
};

/** Historical decoder/integrity replay only. Expected fields must come from
 * independently admitted owned records or content already pinned through that
 * record's root hash, never from an unbound packet/request itself.
 * The fresh server collector can self-check its result, which is not durable
 * admission or an independent proof of provider truth.
 * No Date.now, provider, database or expiry renewal. Raw projections cannot
 * prove RPC provenance/genesis or current chain/source state; original collector
 * admission and future fresh runtime checks remain mandatory. */
export async function replayWarmupExecutionAssets(
  value: unknown,
  rawExpected: unknown,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    const captured = packet.parse(value),
      expected = expectedSchema.parse(rawExpected);
    const e = captured.evidence;
    const accounts = [
      SWAP_WRAPPED_SOL,
      ...expected.mints,
      PAIR_CLOCK,
      PAIR_RENT,
    ];
    if (
      new Set(accounts).size !== accounts.length ||
      e.ownerId !== expected.ownerId ||
      e.reviewId !== expected.reviewId ||
      e.reviewSha256 !== expected.reviewSha256 ||
      e.sourceSnapshotSha256 !== expected.sourceSnapshotSha256 ||
      captured.evidenceSha256 !== expected.evidenceSha256 ||
      e.provider !== expected.provider ||
      e.expiresAt !== expected.expiresAt
    )
      return fail();
    const start = Date.parse(expected.reviewedAt),
      end = Date.parse(expected.reviewExpiresAt),
      beforeAt = Date.parse(e.before.evaluatedServerAt),
      afterAt = Date.parse(e.after.evaluatedServerAt),
      checked = Date.parse(e.checkedAt),
      expires = Date.parse(e.expiresAt);
    if (
      start < 0 ||
      end <= start ||
      end - start > 60000 ||
      beforeAt < start ||
      afterAt < beforeAt ||
      checked < afterAt ||
      expires <= checked ||
      expires > end ||
      expires > beforeAt + 25000 ||
      e.before.slot < e.floorSlot ||
      e.after.slot < e.before.slot
    )
      return fail();
    requireConsistentSolanaSlots([e.floorSlot, e.before.slot, e.after.slot]);
    if ((await digest(canonical(e))) !== expected.evidenceSha256) return fail();
    signal.throwIfAborted();
    const decode = async (o: z.infer<typeof observation>) => {
      if (
        o.accounts.length !== accounts.length ||
        o.accounts.some((a, i) => a.address !== accounts[i])
      )
        return fail();
      for (const a of o.accounts)
        if (
          a.address !== PAIR_RENT &&
          (Object.hasOwn(a.account, 'lamports') ||
            Object.hasOwn(a.account, 'space'))
        )
          return fail();
      const clock = pairClockUnixTimestamp(
        o.accounts.at(-2)!.account,
        o.slot,
        Date.parse(o.evaluatedServerAt),
      );
      const decodedRent = inspectPairRentAccount(o.accounts.at(-1)!.account);
      const mints = await Promise.all(
        o.accounts
          .slice(0, -2)
          .map((a) => inspectSwapMintAccount(a.account, a.address)),
      );
      signal.throwIfAborted();
      if (
        clock !== o.unixTimestamp ||
        canonical(decodedRent) !== canonical(o.rent) ||
        canonical(mints) !== canonical(o.mints)
      )
        return fail();
      return { slot: o.slot, mints, rent: decodedRent };
    };
    const before = await decode(e.before),
      after = await decode(e.after);
    assertSameSwapMintEvidence(before, after);
    // Conservative warmup consistency: ambiguous/forked observations require
    // another review. This is not proof that both reads came from one bank.
    if (
      BigInt(e.after.unixTimestamp) < BigInt(e.before.unixTimestamp) ||
      (e.after.slot === e.before.slot &&
        e.after.accounts.at(-2)!.account.data[0] !==
          e.before.accounts.at(-2)!.account.data[0])
    )
      return fail();
    if (canonical(before.rent) !== canonical(after.rent)) return fail();
    const accountRents = after.mints.map((m) => {
      const size =
        m.program === SWAP_TOKEN ? 165 : SWAP_TOKEN_2022_ACCOUNT_SIZE;
      return {
        ...m,
        accountSize: size,
        minimumRentLamports: pairRentMinimumRaw(after.rent, size),
      };
    });
    if (canonical(accountRents) !== canonical(e.tokenAccountRents))
      return fail();
    signal.throwIfAborted();
    return {
      evidence: e,
      evidenceSha256: captured.evidenceSha256,
      scope: 'historical-asset-decoder-integrity-only' as const,
      networkObservationReverified: false as const,
      currentSourceVerified: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      automaticExecutionAllowed: false as const,
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
