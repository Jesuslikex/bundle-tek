import {
  AccountRole,
  address,
  blockhash,
  getAddressEncoder,
  getProgramDerivedAddress,
  isOffCurveAddress,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  compileTransaction,
  getTransactionEncoder,
  getBase64Decoder,
  type Address,
  type Instruction,
} from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import bs58 from 'bs58';
import { metadataAccount } from './launchlab-platform-launch';

/**
 * Meteora Dynamic Bonding Curve launches. Like Proxima, the user supplies an
 * existing DBC config key (created by a launchpad partner or themselves) and
 * Bundle creates the token and its virtual pool from it, with an optional
 * creator first buy in the same transaction. Layouts follow the official
 * @meteora-ag/dynamic-bonding-curve-sdk IDL; the golden test pins the bytes
 * produced by its createPoolWithFirstBuy.
 */
export const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const DBC_POOL_AUTHORITY =
  'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
export const DBC_EVENT_AUTHORITY =
  '8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Quote tokens Bundle offers for DBC; both are permissionless classic SPL mints. */
export const DBC_QUOTES: Record<string, { symbol: string; decimals: number }> =
  {
    [WRAPPED_SOL]: { symbol: 'SOL', decimals: 9 },
    [USDC]: { symbol: 'USDC', decimals: 6 },
  };
const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const SYSTEM = '11111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
const INIT_SPL = [140, 85, 215, 176, 102, 54, 104, 79];
const INIT_TOKEN_2022 = [169, 118, 51, 78, 145, 110, 220, 155];
const SWAP = [248, 198, 158, 145, 225, 117, 135, 200];
const POOL_CONFIG_DISCRIMINATOR = [26, 108, 14, 123, 116, 230, 129, 43];
export const DBC_CONFIG_SIZE = 1048;

const utf8 = new TextEncoder(),
  encoder = getAddressEncoder();
const key = (a: string) => Uint8Array.from(encoder.encode(address(a)));
const b58 = (bytes: Uint8Array) => bs58.encode(bytes);

export type DbcConfig = {
  quoteMint: string;
  feeClaimer: string;
  baseFeeMode: number;
  cliffFeeNumerator: bigint;
  collectFeeMode: number;
  migrationOption: number;
  activationType: number;
  tokenDecimal: number;
  version: number;
  tokenType: number;
  creatorTradingFeePercentage: number;
  tokenUpdateAuthority: number;
  migrationQuoteThreshold: bigint;
  enableFirstSwapWithMinFee: boolean;
  poolCreationFee: bigint;
};

/**
 * Decodes a standard PoolConfig account (IDL offsets) and applies the checks
 * the official SDK makes before it creates a pool from a config. Transfer-hook
 * configs have another discriminator and are refused.
 */
export function parseDbcConfig(data: Uint8Array): DbcConfig {
  if (
    data.length < DBC_CONFIG_SIZE ||
    POOL_CONFIG_DISCRIMINATOR.some((b, i) => data[i] !== b)
  )
    throw new Error('This is not a standard Meteora DBC config.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const config: DbcConfig = {
    quoteMint: b58(data.slice(8, 40)),
    feeClaimer: b58(data.slice(40, 72)),
    cliffFeeNumerator: view.getBigUint64(104, true),
    baseFeeMode: data[130],
    collectFeeMode: data[232],
    migrationOption: data[233],
    activationType: data[234],
    tokenDecimal: data[235],
    version: data[236],
    tokenType: data[237],
    creatorTradingFeePercentage: data[245],
    tokenUpdateAuthority: data[246],
    migrationQuoteThreshold: view.getBigUint64(264, true),
    enableFirstSwapWithMinFee: data[365] === 1,
    poolCreationFee: view.getBigUint64(368, true),
  };
  if (config.baseFeeMode === 2)
    throw new Error(
      'This DBC config uses the deprecated rate-limiter fee and cannot create new pools.',
    );
  if (config.migrationOption === 0)
    throw new Error(
      'This DBC config migrates to deprecated DAMM v1 and cannot create new pools.',
    );
  if (config.tokenUpdateAuthority === 3 || config.tokenUpdateAuthority === 4)
    throw new Error(
      'This DBC config keeps a mint authority, which Meteora allows only with transfer hooks.',
    );
  if (config.tokenType !== 0 && config.tokenType !== 1)
    throw new Error('This DBC config has an unknown token standard.');
  if (config.tokenDecimal < 6 || config.tokenDecimal > 9)
    throw new Error('This DBC config has an unsupported token precision.');
  return config;
}

export async function dbcPoolAddress(
  config: string,
  baseMint: string,
  quoteMint: string,
) {
  const a = key(baseMint),
    b = key(quoteMint);
  // The SDK seeds the larger key first (Buffer.compare order).
  let cmp = 0;
  for (let i = 0; i < 32 && !cmp; i++) cmp = a[i] - b[i];
  const [first, second] = cmp > 0 ? [a, b] : [b, a];
  return (
    await getProgramDerivedAddress({
      programAddress: address(DBC_PROGRAM),
      seeds: [utf8.encode('pool'), key(config), first, second],
    })
  )[0];
}
export async function dbcTokenVault(pool: string, mint: string) {
  return (
    await getProgramDerivedAddress({
      programAddress: address(DBC_PROGRAM),
      seeds: [utf8.encode('token_vault'), key(mint), key(pool)],
    })
  )[0];
}

export type MeteoraDbcInput = {
  name: string;
  symbol: string;
  uri: string;
  payer: string;
  mint: string;
  config: string;
  quoteMint: string;
  /** From the config: 0 classic SPL with Metaplex metadata, 1 Token-2022. */
  baseTokenType: number;
  /** From the config: the first swap carries the instructions sysvar. */
  firstSwapWithMinFee: boolean;
  /** Raw quote units spent by the creator in the same transaction; "0" creates only. */
  devBuyRaw: string;
  /** Minimum raw base tokens the creator receives. Ignored when devBuyRaw is "0". */
  minTokensOutRaw: string;
  blockhash: string;
  lastValidBlockHeight: string;
};
const INPUT_KEYS: (keyof MeteoraDbcInput)[] = [
  'name',
  'symbol',
  'uri',
  'payer',
  'mint',
  'config',
  'quoteMint',
  'baseTokenType',
  'firstSwapWithMinFee',
  'devBuyRaw',
  'minTokensOutRaw',
  'blockhash',
  'lastValidBlockHeight',
];

const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');

const u64Max = 18446744073709551615n;
function u64(value: string, field: string, allowZero = false) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value))
    throw new Error(`Meteora DBC ${field} must be a whole raw amount.`);
  const v = BigInt(value);
  if (v > u64Max || (!allowZero && v === 0n))
    throw new Error(`Meteora DBC ${field} is out of range.`);
  return v;
}
function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function borshString(value: string) {
  const data = utf8.encode(value),
    bytes = new Uint8Array(4 + data.length);
  new DataView(bytes.buffer).setUint32(0, data.length, true);
  bytes.set(data, 4);
  return bytes;
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
const { READONLY, READONLY_SIGNER, WRITABLE, WRITABLE_SIGNER } = AccountRole;

/** Unsigned pool creation (+ optional same-transaction creator buy). Signers: payer and new mint. */
export async function buildMeteoraDbcMessage(supplied: MeteoraDbcInput) {
  if (
    !supplied ||
    typeof supplied !== 'object' ||
    Object.keys(supplied).sort().join() !== [...INPUT_KEYS].sort().join()
  )
    throw new Error('Unsupported Meteora DBC launch option.');
  const input = structuredClone(supplied);
  const payer = address(input.payer),
    mint = address(input.mint),
    config = address(input.config),
    quoteMint = address(input.quoteMint);
  if (
    [payer, mint].some((a) => isOffCurveAddress(a) || a === SYSTEM) ||
    payer === mint ||
    config === mint ||
    quoteMint === mint
  )
    throw new Error(
      'Meteora DBC payer and new mint need distinct wallet-controlled signing keys.',
    );
  if (!DBC_QUOTES[quoteMint])
    throw new Error('Meteora DBC launches pair with SOL or USDC.');
  if (input.baseTokenType !== 0 && input.baseTokenType !== 1)
    throw new Error('Meteora DBC token standard differs.');
  if (typeof input.firstSwapWithMinFee !== 'boolean')
    throw new Error('Meteora DBC first-swap option differs.');
  for (const [value, max] of [
    [input.name, 32],
    [input.symbol, 10],
    [input.uri, 200],
  ] as const)
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      utf8.encode(value).length > max ||
      value
        .split('')
        .some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new Error(
        'Launch identity exceeds its byte limits or contains control characters.',
      );
  const metadata = new URL(input.uri);
  if (
    metadata.protocol !== 'https:' ||
    metadata.username ||
    metadata.password ||
    metadata.hash
  )
    throw new Error('Review an HTTPS metadata URI before launching.');
  const devBuy = u64(input.devBuyRaw, 'creator buy', true),
    minOut = u64(input.minTokensOutRaw, 'minimum tokens', true);
  if (devBuy > 0n && minOut === 0n)
    throw new Error('Creator buy needs a minimum token output.');
  if (devBuy === 0n && minOut !== 0n)
    throw new Error('A create-only launch has no minimum output.');
  const lifetime = u64(input.lastValidBlockHeight, 'blockhash lifetime');
  if (lifetime > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Meteora DBC blockhash lifetime differs.');

  const pool = await dbcPoolAddress(config, mint, quoteMint);
  const baseVault = await dbcTokenVault(pool, mint),
    quoteVault = await dbcTokenVault(pool, quoteMint);
  const baseProgram =
    input.baseTokenType === 0 ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM;
  const createMetas = [
    meta(config, READONLY),
    meta(DBC_POOL_AUTHORITY, READONLY),
    meta(payer, READONLY_SIGNER),
    meta(mint, WRITABLE_SIGNER),
    meta(quoteMint, READONLY),
    meta(pool, WRITABLE),
    meta(baseVault, WRITABLE),
    meta(quoteVault, WRITABLE),
    ...(input.baseTokenType === 0
      ? [
          meta(await metadataAccount(mint), WRITABLE),
          meta(METADATA_PROGRAM, READONLY),
        ]
      : []),
    meta(payer, WRITABLE_SIGNER),
    meta(TOKEN_PROGRAM, READONLY),
    meta(baseProgram, READONLY),
    meta(SYSTEM, READONLY),
    meta(DBC_EVENT_AUTHORITY, READONLY),
    meta(DBC_PROGRAM, READONLY),
  ];
  const instructions: Instruction[] = [
    {
      programAddress: address(DBC_PROGRAM),
      accounts: createMetas,
      data: concat([
        Uint8Array.from(input.baseTokenType === 0 ? INIT_SPL : INIT_TOKEN_2022),
        borshString(input.name),
        borshString(input.symbol),
        borshString(input.uri),
      ]),
    },
  ];
  let baseAta: Address | null = null;
  if (devBuy > 0n) {
    const [quoteAta] = await findAssociatedTokenPda({
      mint: quoteMint,
      owner: payer,
      tokenProgram: address(TOKEN_PROGRAM),
    });
    [baseAta] = await findAssociatedTokenPda({
      mint,
      owner: payer,
      tokenProgram: address(baseProgram),
    });
    // Idempotent: the quote account may already exist.
    const ataCreate = (ata: Address, m: Address, program: string) => ({
      programAddress: address(ATA_PROGRAM),
      accounts: [
        meta(payer, WRITABLE_SIGNER),
        meta(ata, WRITABLE),
        meta(payer, READONLY),
        meta(m, READONLY),
        meta(SYSTEM, READONLY),
        meta(program, READONLY),
      ],
      data: Uint8Array.of(1),
    });
    instructions.push(
      ataCreate(quoteAta, quoteMint, TOKEN_PROGRAM),
      ataCreate(baseAta, mint, baseProgram),
    );
    const wrapped = quoteMint === WRAPPED_SOL;
    if (wrapped) {
      const transfer = new Uint8Array(12);
      new DataView(transfer.buffer).setUint32(0, 2, true);
      new DataView(transfer.buffer).setBigUint64(4, devBuy, true);
      instructions.push(
        {
          programAddress: address(SYSTEM),
          accounts: [meta(payer, WRITABLE_SIGNER), meta(quoteAta, WRITABLE)],
          data: transfer,
        },
        {
          programAddress: address(TOKEN_PROGRAM),
          accounts: [meta(quoteAta, WRITABLE)],
          data: Uint8Array.of(17),
        },
      );
    }
    instructions.push({
      programAddress: address(DBC_PROGRAM),
      accounts: [
        meta(DBC_POOL_AUTHORITY, READONLY),
        meta(config, READONLY),
        meta(pool, WRITABLE),
        meta(quoteAta, WRITABLE),
        meta(baseAta, WRITABLE),
        meta(baseVault, WRITABLE),
        meta(quoteVault, WRITABLE),
        meta(mint, READONLY),
        meta(quoteMint, READONLY),
        meta(payer, READONLY_SIGNER),
        meta(baseProgram, READONLY),
        meta(TOKEN_PROGRAM, READONLY),
        // No referral: Anchor marks the empty optional slot with the program id.
        meta(DBC_PROGRAM, READONLY),
        meta(DBC_EVENT_AUTHORITY, READONLY),
        meta(DBC_PROGRAM, READONLY),
        ...(input.firstSwapWithMinFee
          ? [meta(SYSVAR_INSTRUCTIONS, READONLY)]
          : []),
      ],
      data: concat([Uint8Array.from(SWAP), le64(devBuy), le64(minOut)]),
    });
    if (wrapped)
      instructions.push({
        programAddress: address(TOKEN_PROGRAM),
        accounts: [
          meta(quoteAta, WRITABLE),
          meta(payer, WRITABLE),
          meta(payer, READONLY_SIGNER),
        ],
        data: Uint8Array.of(9),
      });
  }
  const message = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(input.blockhash),
        lastValidBlockHeight: lifetime,
      },
      setTransactionMessageFeePayer(
        payer,
        createTransactionMessage({ version: 'legacy' }),
      ),
    ),
  );
  const compiled = compileTransactionMessage(message);
  if (
    compiled.header.numSignerAccounts !== 2 ||
    compiled.staticAccounts[0] !== payer ||
    compiled.staticAccounts[1] !== mint
  )
    throw new Error('Meteora DBC launch signer set differs.');
  const transaction = compileTransaction(message),
    bytes = Uint8Array.from(getTransactionEncoder().encode(transaction));
  if (
    bytes.length > 1232 ||
    Object.values(transaction.signatures).some((s) => s !== null)
  )
    throw new Error(
      'Launch packet is too large. Shorten the name, symbol or metadata link.',
    );
  return {
    format: 'meteora-dbc-unsigned-v1' as const,
    payer,
    mint,
    config,
    quoteMint,
    pool,
    containsCreatorBuy: devBuy > 0n,
    transaction: getBase64Decoder().decode(bytes),
    packetSha256: await hash(bytes),
    packetBytes: bytes.length,
    baseTokenAccount: baseAta,
    instructions,
  };
}
