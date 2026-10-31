import {
  AccountRole,
  address,
  blockhash,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  compileTransaction,
  getTransactionEncoder,
  getTransactionDecoder,
  getBase64Decoder,
  isOffCurveAddress,
  type Address,
  type Instruction,
} from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import bs58 from 'bs58';
import {
  buildStonkLaunchMessage,
  stonkLaunchAddresses,
  LAUNCHLAB_PROGRAM,
  LAUNCHLAB_AUTH,
  TOKEN_2022_PROGRAM,
  WRAPPED_SOL,
  type StonkLaunchInput,
} from './stonkfun-launch';
import { verifySolanaSignature } from './solana-signature';
import type { StonkBundleReview } from './stonkfun-bundle-service';

/**
 * StonkFun holder bundle: the original create(+creator buy) packet, then up to
 * three holder buy packets (at most two holder wallets each) and one separate
 * deployer-paid Jito tip packet, sent together as one atomic Jito bundle.
 * Every packet shares the create blockhash, so nothing can land after expiry.
 */
export const STONKFUN_BUNDLE_MAX_HOLDERS = 6;
export const STONKFUN_BUNDLE_MAX_HOLDER_PACKETS = 3;
const HOLDERS_PER_PACKET = 2;
const SYSTEM = '11111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const BUY_EXACT_IN = [250, 234, 13, 123, 213, 156, 19, 236];
const FEE_DENOMINATOR = 1_000_000n;
const u64Max = 18446744073709551615n;

export type StonkHolderBuy = {
  holder: string;
  buyRaw: string;
  minTokensOutRaw: string;
};
export type StonkBundleInput = {
  holders: StonkHolderBuy[];
  tipAccount: string;
  tipLamports: string;
};
export type StonkBundlePacket = {
  kind: 'holders' | 'tip';
  signers: string[];
  transaction: string;
  sha256: string;
};

const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
function raw(value: unknown, field: string, allowZero = false) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value))
    throw new Error(`StonkFun bundle ${field} must be a whole raw amount.`);
  const v = BigInt(value);
  if (v > u64Max || (!allowZero && v === 0n))
    throw new Error(`StonkFun bundle ${field} is out of range.`);
  return v;
}
function le64(value: bigint) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}
const meta = (a: Address | string, role: AccountRole) => ({
  address: address(a),
  role,
});
const { READONLY, WRITABLE, WRITABLE_SIGNER } = AccountRole;
function budget(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: address(COMPUTE_BUDGET), data };
}

async function holderInstructions(
  launch: StonkLaunchInput,
  buy: StonkHolderBuy,
) {
  const holder = address(buy.holder),
    mint = address(launch.mint),
    quoteMint = address(launch.quoteMint),
    quoteProgram = address(launch.quoteTokenProgram);
  const amount = raw(buy.buyRaw, 'holder buy'),
    minOut = raw(buy.minTokensOutRaw, 'holder minimum');
  const accounts = await stonkLaunchAddresses(
    mint,
    quoteMint,
    launch.platformId,
    launch.payer,
  );
  if (accounts.auth !== LAUNCHLAB_AUTH)
    throw new Error('LaunchLab authority differs.');
  const [baseAta] = await findAssociatedTokenPda({
    mint,
    owner: holder,
    tokenProgram: address(TOKEN_2022_PROGRAM),
  });
  const [quoteAta] = await findAssociatedTokenPda({
    mint: quoteMint,
    owner: holder,
    tokenProgram: quoteProgram,
  });
  // The holder funds its own accounts; the packet fee payer only pays fees.
  const ataCreate = (
    ata: Address,
    m: Address,
    tokenProgram: Address,
  ): Instruction => ({
    programAddress: address(ATA_PROGRAM),
    accounts: [
      meta(holder, WRITABLE_SIGNER),
      meta(ata, WRITABLE),
      meta(holder, READONLY),
      meta(m, READONLY),
      meta(SYSTEM, READONLY),
      meta(tokenProgram, READONLY),
    ],
    data: Uint8Array.of(1),
  });
  const out: Instruction[] = [
    ataCreate(baseAta, mint, address(TOKEN_2022_PROGRAM)),
  ];
  const wrapped = quoteMint === WRAPPED_SOL;
  if (wrapped) {
    const transfer = new Uint8Array(12);
    new DataView(transfer.buffer).setUint32(0, 2, true);
    new DataView(transfer.buffer).setBigUint64(4, amount, true);
    out.push(
      ataCreate(quoteAta, quoteMint, quoteProgram),
      {
        programAddress: address(SYSTEM),
        accounts: [meta(holder, WRITABLE_SIGNER), meta(quoteAta, WRITABLE)],
        data: transfer,
      },
      {
        programAddress: quoteProgram,
        accounts: [meta(quoteAta, WRITABLE)],
        data: Uint8Array.of(17),
      },
    );
  }
  out.push({
    programAddress: address(LAUNCHLAB_PROGRAM),
    accounts: [
      meta(holder, WRITABLE_SIGNER),
      meta(accounts.auth, READONLY),
      meta(launch.configId, READONLY),
      meta(launch.platformId, READONLY),
      meta(accounts.pool, WRITABLE),
      meta(baseAta, WRITABLE),
      meta(quoteAta, WRITABLE),
      meta(accounts.vaultA, WRITABLE),
      meta(accounts.vaultB, WRITABLE),
      meta(mint, READONLY),
      meta(quoteMint, READONLY),
      meta(TOKEN_2022_PROGRAM, READONLY),
      meta(quoteProgram, READONLY),
      meta(accounts.eventAuthority, READONLY),
      meta(LAUNCHLAB_PROGRAM, READONLY),
      meta(SYSTEM, READONLY),
      meta(accounts.platformFeeVault, WRITABLE),
      meta(accounts.creatorFeeVault, WRITABLE),
    ],
    data: Uint8Array.from([
      ...BUY_EXACT_IN,
      ...le64(amount),
      ...le64(minOut),
      ...le64(0n),
    ]),
  });
  if (wrapped)
    out.push({
      programAddress: quoteProgram,
      accounts: [
        meta(quoteAta, WRITABLE),
        meta(holder, WRITABLE),
        meta(holder, WRITABLE_SIGNER),
      ],
      data: Uint8Array.of(9),
    });
  return { instructions: out, baseAta };
}

async function compile(
  launch: StonkLaunchInput,
  feePayer: Address,
  instructions: Instruction[],
  signers: string[],
) {
  const message = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(launch.blockhash),
        lastValidBlockHeight: BigInt(launch.lastValidBlockHeight),
      },
      setTransactionMessageFeePayer(
        feePayer,
        createTransactionMessage({ version: 'legacy' }),
      ),
    ),
  );
  const compiled = compileTransactionMessage(message);
  if (
    compiled.header.numSignerAccounts !== signers.length ||
    signers.some((s, i) => compiled.staticAccounts[i] !== s)
  )
    throw new Error('StonkFun bundle signer set differs.');
  const bytes = Uint8Array.from(
    getTransactionEncoder().encode(compileTransaction(message)),
  );
  return { bytes, fits: bytes.length <= 1232 };
}

/** Holders split into packets of up to two; a pair that does not fit is split. */
async function holderPackets(
  launch: StonkLaunchInput,
  holders: StonkHolderBuy[],
) {
  const packets: StonkBundlePacket[] = [];
  let i = 0;
  while (i < holders.length) {
    let size = Math.min(HOLDERS_PER_PACKET, holders.length - i);
    for (;;) {
      const group = holders.slice(i, i + size);
      const feePayer = address(group[0].holder);
      const instructions: Instruction[] = [budget(300_000 * group.length)];
      for (const buy of group)
        instructions.push(
          ...(await holderInstructions(launch, buy)).instructions,
        );
      const signers = group.map((g) => g.holder);
      const built = await compile(launch, feePayer, instructions, signers);
      if (built.fits) {
        packets.push({
          kind: 'holders',
          signers,
          transaction: getBase64Decoder().decode(built.bytes),
          sha256: await hash(built.bytes),
        });
        i += size;
        break;
      }
      if (size === 1)
        throw new Error('StonkFun holder buy packet is too large.');
      size = 1;
    }
  }
  return packets;
}

async function tipPacket(launch: StonkLaunchInput, input: StonkBundleInput) {
  const payer = address(launch.payer),
    lamports = raw(input.tipLamports, 'Jito tip');
  if (lamports < 1000n || lamports > 10_000_000n)
    throw new Error('Choose a Jito tip from 1,000 to 10,000,000 lamports.');
  const transfer = new Uint8Array(12);
  new DataView(transfer.buffer).setUint32(0, 2, true);
  new DataView(transfer.buffer).setBigUint64(4, lamports, true);
  const built = await compile(
    launch,
    payer,
    [
      {
        programAddress: address(SYSTEM),
        accounts: [
          meta(payer, WRITABLE_SIGNER),
          meta(input.tipAccount, WRITABLE),
        ],
        data: transfer,
      },
    ],
    [payer],
  );
  if (!built.fits) throw new Error('StonkFun tip packet differs.');
  return {
    kind: 'tip' as const,
    signers: [launch.payer],
    transaction: getBase64Decoder().decode(built.bytes),
    sha256: await hash(built.bytes),
  };
}

/** Deterministic unsigned holder and tip packets. Server and browser build the same bytes. */
export async function buildStonkBundle(
  launch: StonkLaunchInput,
  supplied: StonkBundleInput,
) {
  if (
    !supplied ||
    typeof supplied !== 'object' ||
    Object.keys(supplied).sort().join() !== 'holders,tipAccount,tipLamports' ||
    !Array.isArray(supplied.holders) ||
    supplied.holders.length < 1 ||
    supplied.holders.length > STONKFUN_BUNDLE_MAX_HOLDERS
  )
    throw new Error(
      `Choose 1 to ${STONKFUN_BUNDLE_MAX_HOLDERS} holder wallets for a StonkFun bundle.`,
    );
  const input = structuredClone(supplied);
  const keys = new Set([launch.payer, launch.mint]);
  for (const h of input.holders) {
    if (
      !h ||
      typeof h !== 'object' ||
      Object.keys(h).sort().join() !== 'buyRaw,holder,minTokensOutRaw'
    )
      throw new Error('Unsupported StonkFun holder buy.');
    const a = address(h.holder);
    if (isOffCurveAddress(a) || a === SYSTEM || keys.has(a))
      throw new Error(
        'StonkFun holder wallets must be distinct wallet-controlled keys.',
      );
    keys.add(a);
    raw(h.buyRaw, 'holder buy');
    raw(h.minTokensOutRaw, 'holder minimum');
  }
  const tipAccount = address(input.tipAccount);
  if (keys.has(tipAccount)) throw new Error('Jito tip account differs.');
  const create = await buildStonkLaunchMessage(launch);
  const holders = await holderPackets(launch, input.holders);
  if (holders.length > STONKFUN_BUNDLE_MAX_HOLDER_PACKETS)
    throw new Error('StonkFun bundle needs too many packets.');
  const tip = await tipPacket(launch, input);
  const packets = [...holders, tip];
  const sha256 = await hash(
    new TextEncoder().encode(
      JSON.stringify({
        format: 'stonkfun-holder-bundle-v1',
        create: create.packetSha256,
        packets: packets.map((p) => p.sha256),
      }),
    ),
  );
  return { create, packets, sha256 };
}

const decodeTx = (value: string) =>
  getTransactionDecoder().decode(
    Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
  );
const canonical = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value.length > 1800) return false;
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
};

/** Pure check that each signed packet is exactly the reviewed one with all its signatures. Returns signatures. */
export function verifyStonkBundleSigned(
  packets: StonkBundlePacket[],
  signed: unknown,
) {
  if (
    !Array.isArray(signed) ||
    signed.length !== packets.length ||
    !signed.every(canonical)
  )
    throw new Error('Signed StonkFun bundle differs.');
  return packets.map((packet, i) => {
    const original = decodeTx(packet.transaction),
      tx = decodeTx(signed[i] as string);
    if (
      getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !==
        signed[i] ||
      tx.messageBytes.length !== original.messageBytes.length ||
      !tx.messageBytes.every((b, j) => b === original.messageBytes[j]) ||
      Object.keys(tx.signatures).length !== packet.signers.length
    )
      throw new Error('Signed StonkFun bundle packet differs.');
    for (const key of packet.signers) {
      const sig = tx.signatures[address(key)];
      if (
        !sig ||
        !verifySolanaSignature(
          Uint8Array.from(tx.messageBytes),
          Uint8Array.from(sig),
          bs58.decode(key),
        )
      )
        throw new Error('StonkFun bundle signatures are incomplete.');
    }
    return bs58.encode(tx.signatures[address(packet.signers[0])]!);
  });
}

/* ---------- LaunchLab constant-product curve (Raydium SDK v2 Curve.buyExactIn) ---------- */

export type StonkCurveState = {
  virtualA: bigint;
  virtualB: bigint;
  realA: bigint;
  realB: bigint;
  totalSellA: bigint;
};
/** LaunchpadPool layout: supply @21, totalSellA @29, virtualA @37, virtualB @45, realA @53, realB @61. */
export function decodeStonkPool(data: Uint8Array): StonkCurveState {
  if (data.length < 69) throw new Error('LaunchLab pool account differs.');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    totalSellA: v.getBigUint64(29, true),
    virtualA: v.getBigUint64(37, true),
    virtualB: v.getBigUint64(45, true),
    realA: v.getBigUint64(53, true),
    realB: v.getBigUint64(61, true),
  };
}
/** Total fee rate (millionths): config trade fee + platform fee + platform creator fee. */
export function stonkFeeRate(config: Uint8Array, platform: Uint8Array) {
  if (config.length < 35 || platform.length < 728)
    throw new Error('LaunchLab fee accounts differ.');
  const c = new DataView(config.buffer, config.byteOffset, config.byteLength),
    p = new DataView(platform.buffer, platform.byteOffset, platform.byteLength);
  const rate =
    c.getBigUint64(27, true) +
    p.getBigUint64(104, true) +
    p.getBigUint64(720, true);
  if (rate >= FEE_DENOMINATOR) throw new Error('LaunchLab fee rate differs.');
  return rate;
}
/** Exact-in buy on the constant-product curve; mutates and returns the next state. */
export function stonkBuyExactIn(
  state: StonkCurveState,
  amountB: bigint,
  feeRate: bigint,
) {
  const fee = (amountB * feeRate + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
  const less = amountB - fee;
  const inputReserve = state.virtualB + state.realB,
    outputReserve = state.virtualA - state.realA;
  const out = (less * outputReserve) / (inputReserve + less);
  if (out <= 0n) throw new Error('StonkFun holder buy is too small.');
  if (out > state.totalSellA - state.realA)
    throw new Error(
      'Holder buys would finish the StonkFun curve. Lower the amounts.',
    );
  return {
    tokensOut: out,
    next: { ...state, realA: state.realA + out, realB: state.realB + less },
  };
}

/** Rebuilds holder and tip packets from the review; any mismatch refuses. Pure, used by server and browser. */
export async function verifyStonkBundleReview(review: StonkBundleReview) {
  const b = review.bundle;
  if (
    !b ||
    b.format !== 'stonkfun-holder-bundle-v1' ||
    !Array.isArray(b.holders) ||
    !Array.isArray(review.terms.holders) ||
    b.holders.length !== review.terms.holders.length ||
    b.tipLamports !== review.terms.tipLamports ||
    b.holders.some(
      (h, i) =>
        h.holder !== review.terms.holders[i].address ||
        h.revision !== review.terms.holders[i].revision ||
        h.buyRaw !== review.terms.holders[i].buyRaw ||
        BigInt(h.minTokensOutRaw) > BigInt(h.expectedTokensOutRaw),
    )
  )
    throw new Error('Saved StonkFun bundle differs from its terms.');
  const built = await buildStonkBundle(review.input, {
    holders: b.holders.map(({ holder, buyRaw, minTokensOutRaw }) => ({
      holder,
      buyRaw,
      minTokensOutRaw,
    })),
    tipAccount: b.tipAccount,
    tipLamports: b.tipLamports,
  });
  if (
    built.create.packetSha256 !== review.sha256 ||
    built.create.transaction !== review.transaction ||
    built.sha256 !== b.sha256 ||
    built.packets.length !== b.packets.length ||
    built.packets.some(
      (p, i) =>
        p.transaction !== b.packets[i].transaction ||
        p.sha256 !== b.packets[i].sha256 ||
        p.kind !== b.packets[i].kind ||
        p.signers.join() !== b.packets[i].signers.join(),
    )
  )
    throw new Error('Saved StonkFun bundle packets differ.');
  return built;
}
