import bs58 from 'bs58';
import type { JitoSimulationAccount } from './jito-bundle-simulation-frames';
import {
  supportedSwapTokenProgram,
  swapTokenBytes,
  SWAP_TOKEN,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';

const fail = (): never => {
  throw Error('Bundle wallet token state differs.');
};
const key = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    return fail();
  try {
    const bytes = bs58.decode(value);
    if (bytes.length === 32 && bs58.encode(bytes) === value) return value;
  } catch {
    /* Refuse below. */
  }
  return fail();
};
const uint = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    return fail();
  return BigInt(value);
};
export type JitoWalletTokenBalance = {
  accountIndex: string;
  mint: string;
  owner: string;
  programId: string;
  uiTokenAmount: { amount: string; decimals: string };
};
/** Decode wallet-owned SPL units only, not positions held by arbitrary programs.
 * Mint evidence must be independently admitted by the caller.
 * No freshness, custody continuity, signing, execution or provider authority is granted. */
export function decodeJitoWalletTokenBalances(
  keys: string[],
  accounts: (JitoSimulationAccount | null)[],
  wallet: string,
  mints: { address: string; program: string; decimals: number }[],
): JitoWalletTokenBalance[] {
  key(wallet);
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > 256 ||
    keys.some((value) => key(value) !== value) ||
    new Set(keys).size !== keys.length ||
    !Array.isArray(accounts) ||
    accounts.length !== keys.length ||
    !Array.isArray(mints) ||
    mints.length !== 2
  )
    return fail();
  const policies = new Map<string, (typeof mints)[number]>();
  for (const mint of mints) {
    if (
      !mint ||
      key(mint.address) !== mint.address ||
      !supportedSwapTokenProgram(mint.program) ||
      !Number.isInteger(mint.decimals) ||
      mint.decimals < 0 ||
      mint.decimals > 18 ||
      policies.has(mint.address) ||
      (mint.address === SWAP_WRAPPED_SOL &&
        (mint.program !== SWAP_TOKEN || mint.decimals !== 9))
    )
      return fail();
    policies.set(mint.address, mint);
  }
  if (!policies.has(SWAP_WRAPPED_SOL)) return fail();
  const result: JitoWalletTokenBalance[] = [];
  let totalBytes = 0;
  for (let i = 0; i < keys.length; i++) {
    if (!Object.hasOwn(keys, i) || !Object.hasOwn(accounts, i)) return fail();
    const account = accounts[i];
    if (account === null) continue;
    if (
      !account ||
      key(account.owner) !== account.owner ||
      typeof account.executable !== 'boolean' ||
      !(account.data instanceof Uint8Array) ||
      account.data.byteLength > 524288
    )
      return fail();
    const lamports = uint(account.lamports),
      bytes = Uint8Array.from(account.data);
    totalBytes += bytes.byteLength;
    if (totalBytes > 2097152) return fail();
    if (!supportedSwapTokenProgram(account.owner)) {
      if (policies.has(keys[i])) return fail();
      continue;
    }
    if (account.executable) return fail();
    const raw = {
      ...account,
      data: [Buffer.from(bytes).toString('base64'), 'base64'],
    };
    const view = new DataView(bytes.buffer);
    // Foreign mint extension bytes are opaque, not admitted transfer policy or wallet units.
    if (bytes.length === 82 || (bytes.length >= 166 && bytes[165] === 1)) {
      const policy = policies.get(keys[i]);
      if (policy) swapTokenBytes(raw, true);
      if (
        (policy &&
          (policy.program !== account.owner ||
            bytes[44] !== policy.decimals)) ||
        bytes[45] !== 1 ||
        view.getUint32(0, true) > 1 ||
        view.getUint32(46, true) > 1
      )
        return fail();
      continue;
    }
    if (policies.has(keys[i])) return fail();
    if (
      bytes.length < 165 ||
      bytes.length > 16384 ||
      (bytes.length !== 165 && bytes[165] !== 2) ||
      view.getUint32(72, true) > 1 ||
      view.getUint32(109, true) > 1 ||
      view.getUint32(129, true) > 1 ||
      ![1, 2].includes(bytes[108])
    )
      return fail();
    const owner = key(bs58.encode(bytes.slice(32, 64)));
    if (owner !== wallet) continue;
    swapTokenBytes(raw, false);
    const mint = key(bs58.encode(bytes.slice(0, 32))),
      policy = policies.get(mint);
    const amount = view.getBigUint64(64, true),
      native = view.getUint32(109, true);
    // COption None ignores its inactive body; revoked authority/reserve bytes may remain.
    if (
      !policy ||
      policy.program !== account.owner ||
      bytes[108] !== 1 ||
      view.getUint32(72, true) !== 0 ||
      view.getBigUint64(121, true) !== 0n ||
      view.getUint32(129, true) !== 0 ||
      (mint === SWAP_WRAPPED_SOL
        ? native !== 1 ||
          lamports < amount ||
          lamports - amount !== view.getBigUint64(113, true)
        : native !== 0)
    )
      return fail();
    result.push({
      accountIndex: String(i),
      mint,
      owner,
      programId: account.owner,
      uiTokenAmount: {
        amount: amount.toString(),
        decimals: String(policy.decimals),
      },
    });
  }
  return result;
}
