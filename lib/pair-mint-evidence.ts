import {
  getExtensionDecoder,
  getExtensionEncoder,
  type Extension,
} from '@solana-program/token-2022';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';
import {
  pairMultiplierHex,
  activePairMultiplier,
  type PairAmountPolicy,
} from './pair-ui-amount';

export const PAIR_CLOCK = 'SysvarC1ock11111111111111111111111111111111';
export const PAIR_SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
export const PAIR_QUOTE_EXTENSIONS = [
  'ConfidentialTransferMint',
  'DefaultAccountState',
  'MetadataPointer',
  'PausableConfig',
  'PermanentDelegate',
  'ScaledUiAmountConfig',
  'TokenMetadata',
  'TransferHook',
] as const;
export const PAIR_ISSUER_CONTROLS = [
  'freezable',
  'mintable',
  'pausable',
  'permanent-delegate',
  'transfer-hook-upgradable',
  'ui-multiplier-upgradable',
] as const;
export type PairIssuerControl = (typeof PAIR_ISSUER_CONTROLS)[number];
export type PairMintMetadata = {
  address: string;
  program: string;
  decimals: number;
  policySha256: string;
  amountPolicy: PairAmountPolicy;
  extensions: string[];
  issuerControls: PairIssuerControl[];
};
export type PairMintEvidence = {
  slot: number;
  unixTimestamp: string;
  mints: PairMintMetadata[];
};
export class PairMintPolicyError extends Error {
  constructor(
    message = 'This pair has an unsupported or invalid mint policy.',
  ) {
    super(message);
    this.name = 'PairMintPolicyError';
  }
}
export function pairClockUnixTimestamp(
  raw: unknown,
  slot: number,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(slot) || slot < 1)
    throw new Error('Pair chain clock slot is invalid.');
  const clock = accountBytes(raw, true).bytes;
  const view = new DataView(clock.buffer);
  const unix = view.getBigInt64(32, true);
  if (
    view.getBigUint64(0, true) !== BigInt(slot) ||
    unix < 1n ||
    unix > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isFinite(now) ||
    Math.abs(Number(unix) * 1000 - now) > 30000
  )
    throw new Error('Pair chain clock is inconsistent or stale.');
  return unix.toString();
}
function accountBytes(raw: unknown, clock = false) {
  const a = raw as { owner?: unknown; executable?: unknown; data?: unknown };
  if (
    !a ||
    a.executable !== false ||
    !(clock
      ? a.owner === PAIR_SYSVAR_OWNER
      : a.owner === SWAP_TOKEN || a.owner === SWAP_TOKEN_2022) ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length > 21848
  )
    throw new Error('Pair mint or clock RPC account is unavailable.');
  const text = atob(a.data[0]);
  if (
    btoa(text) !== a.data[0] ||
    (clock ? text.length !== 40 : text.length < 82 || text.length > 16384)
  )
    throw new Error('Pair mint or clock RPC account is noncanonical.');
  return {
    bytes: Uint8Array.from(text, (c) => c.charCodeAt(0)),
    program: a.owner as string,
  };
}
function extensions(bytes: Uint8Array, program: string): Extension[] {
  if (bytes.length === 82) return [];
  if (
    program !== SWAP_TOKEN_2022 ||
    bytes.length < 166 ||
    bytes[165] !== 1 ||
    bytes.slice(82, 165).some((b) => b !== 0)
  )
    throw new PairMintPolicyError();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Extension[] = [];
  for (let offset = 166; offset < bytes.length;) {
    if (bytes.slice(offset).every((b) => b === 0)) break;
    if (offset + 4 > bytes.length) throw new PairMintPolicyError();
    const end = offset + 4 + view.getUint16(offset + 2, true);
    if (end > bytes.length) throw new PairMintPolicyError();
    const encoded = bytes.slice(offset, end);
    try {
      const item = getExtensionDecoder().decode(encoded);
      if (
        !(PAIR_QUOTE_EXTENSIONS as readonly string[]).includes(item.__kind) ||
        result.some((e) => e.__kind === item.__kind)
      )
        throw new PairMintPolicyError();
      const canonical = getExtensionEncoder().encode(item);
      if (
        canonical.length !== encoded.length ||
        canonical.some((b, i) => b !== encoded[i])
      )
        throw new PairMintPolicyError();
      result.push(item);
    } catch {
      throw new PairMintPolicyError();
    }
    offset = end;
  }
  return result;
}
async function mint(raw: unknown, address: string): Promise<PairMintMetadata> {
  const { bytes, program } = accountBytes(raw);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes[45] !== 1 ||
    bytes[44] > 18 ||
    view.getUint32(0, true) > 1 ||
    view.getUint32(46, true) > 1 ||
    (address === SWAP_WRAPPED_SOL &&
      (program !== SWAP_TOKEN || bytes[44] !== 9))
  )
    throw new PairMintPolicyError();
  const decoded = extensions(bytes, program);
  const names = decoded.map((e) => e.__kind).sort();
  const controls: PairIssuerControl[] = [];
  if (view.getUint32(0, true)) controls.push('mintable');
  if (view.getUint32(46, true)) controls.push('freezable');
  let amountPolicy: PairAmountPolicy = { kind: 'unscaled' };
  for (const e of decoded) {
    if (e.__kind === 'TokenMetadata' && e.mint !== address)
      throw new PairMintPolicyError('Token metadata names a different mint.');
    if (e.__kind === 'DefaultAccountState' && e.state !== 1)
      throw new PairMintPolicyError(
        'This mint initializes frozen accounts. A separate account policy is required.',
      );
    if (e.__kind === 'PausableConfig') {
      if (e.paused)
        throw new PairMintPolicyError(
          'This mint is paused. Request a new quote after its policy changes.',
        );
      if (e.authority.__option === 'Some') controls.push('pausable');
    }
    if (
      e.__kind === 'PermanentDelegate' &&
      e.delegate !== '11111111111111111111111111111111'
    )
      controls.push('permanent-delegate');
    if (e.__kind === 'TransferHook') {
      if (e.programId !== '11111111111111111111111111111111')
        throw new PairMintPolicyError(
          'An active transfer hook requires a separate quote and settlement adapter.',
        );
      if (e.authority !== '11111111111111111111111111111111')
        controls.push('transfer-hook-upgradable');
    }
    if (e.__kind === 'ScaledUiAmountConfig') {
      try {
        amountPolicy = {
          kind: 'scaled-ui-v1',
          multiplierHex: pairMultiplierHex(e.multiplier),
          nextMultiplierHex: pairMultiplierHex(e.newMultiplier),
          effectiveTimestamp: e.newMultiplierEffectiveTimestamp.toString(),
        };
      } catch {
        throw new PairMintPolicyError(
          'This mint has an invalid scaled amount multiplier.',
        );
      }
      if (e.authority !== '11111111111111111111111111111111')
        controls.push('ui-multiplier-upgradable');
    }
  }
  // Supply changes are not transfer-policy changes. Everything else remains bound.
  const policy = Uint8Array.from(bytes);
  policy.fill(0, 36, 44);
  const digest = await crypto.subtle.digest('SHA-256', policy.buffer);
  return {
    address,
    program,
    decimals: bytes[44],
    amountPolicy,
    extensions: names,
    issuerControls: controls.sort(),
    policySha256: Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
  };
}
/** Read-only pair policy. This profile is deliberately NOT a signing/settlement proof. */
export async function readPairMintEvidence(
  pair: { inputMint: string; outputMint: string },
  minContextSlot: number,
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  now = Date.now(),
): Promise<PairMintEvidence> {
  if (
    !Number.isSafeInteger(minContextSlot) ||
    minContextSlot < 1 ||
    pair.inputMint === pair.outputMint
  )
    throw new Error('Pair identity scope is invalid.');
  const result = (await rpc('getMultipleAccounts', [
    [pair.inputMint, pair.outputMint, PAIR_CLOCK],
    { encoding: 'base64', commitment: 'confirmed', minContextSlot },
  ])) as { context?: { slot?: unknown }; value?: unknown[] };
  const rawSlot = result?.context?.slot;
  if (
    typeof rawSlot !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(rawSlot) ||
    !Number.isSafeInteger(Number(rawSlot)) ||
    Number(rawSlot) < minContextSlot ||
    Number(rawSlot) > minContextSlot + 32 ||
    !Array.isArray(result.value) ||
    result.value.length !== 3
  )
    throw new Error('Pair identity RPC context is unavailable.');
  const unixTimestamp = pairClockUnixTimestamp(
    result.value[2],
    Number(rawSlot),
    now,
  );
  return {
    slot: Number(rawSlot),
    unixTimestamp,
    mints: await Promise.all([
      mint(result.value[0], pair.inputMint),
      mint(result.value[1], pair.outputMint),
    ]),
  };
}
export function assertSamePairMintEvidence(
  before: PairMintEvidence,
  after: PairMintEvidence,
) {
  const identity = (m: PairMintMetadata) => [
    m.address,
    m.program,
    m.decimals,
    m.policySha256,
    m.amountPolicy.kind === 'unscaled'
      ? ['unscaled']
      : [
          m.amountPolicy.kind,
          m.amountPolicy.multiplierHex,
          m.amountPolicy.nextMultiplierHex,
          m.amountPolicy.effectiveTimestamp,
        ],
    m.extensions,
    m.issuerControls,
  ];
  if (
    before.mints.length !== 2 ||
    after.mints.length !== 2 ||
    after.slot < before.slot ||
    after.slot > before.slot + 32 ||
    BigInt(after.unixTimestamp) < BigInt(before.unixTimestamp) ||
    BigInt(after.unixTimestamp) > BigInt(before.unixTimestamp) + 60n ||
    JSON.stringify(before.mints.map(identity)) !==
      JSON.stringify(after.mints.map(identity)) ||
    before.mints.some(
      (m, i) =>
        activePairMultiplier(m.amountPolicy, before.unixTimestamp) !==
        activePairMultiplier(after.mints[i].amountPolicy, after.unixTimestamp),
    )
  )
    throw new PairMintPolicyError(
      'Token pair policy or its active UI multiplier changed. Request a fresh quote.',
    );
}
