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
import {
  LAUNCHLAB_AUTH,
  LAUNCHLAB_PROGRAM,
  TOKEN_PROGRAM,
  WRAPPED_SOL,
  stonkAllowConfigId,
  stonkConfigId,
  stonkCurveRuleId,
  stonkLaunchAddresses,
} from './stonkfun-launch';

/**
 * LetsBonk and Surge launches are Raydium LaunchLab pools created under each
 * venue's platform config, as listed in Raydium's public platform registry
 * (https://launch-mint-v1.raydium.io/main/platforms). Tokens are classic SPL
 * mints with Metaplex metadata, created by initialize_v2. Layouts follow the
 * official @raydium-io/raydium-sdk-v2 encoders; the golden test pins bytes.
 */
export const LAUNCHLAB_VENUES = ['LetsBonk', 'Surge'] as const;
export type LaunchLabVenue = (typeof LAUNCHLAB_VENUES)[number];
export const LAUNCHLAB_PLATFORMS: Record<LaunchLabVenue, string> = {
  LetsBonk: 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1',
  Surge: 'Dt9xZGWUYyN44Vxfz9qLQGERhtR2taDnLG1B8XbDEWWN',
};
export const USD1 = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
/**
 * Raydium's published default constant-curve parameters for the standard
 * quote configs (https://launch-mint-v1.raydium.io/main/configs).
 */
export const LAUNCHLAB_CURVES: Record<
  string,
  {
    configId: string;
    symbol: string;
    decimals: number;
    supply: string;
    totalSellA: string;
    totalFundRaisingB: string;
  }
> = {
  [WRAPPED_SOL]: {
    configId: '6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX',
    symbol: 'SOL',
    decimals: 9,
    supply: '1000000000000000',
    totalSellA: '793100000000000',
    totalFundRaisingB: '85000000000',
  },
  [USD1]: {
    configId: 'EPiZbnrThjyLnoQ6QQzkxeFqyL5uyg9RzNHHAudUPxBz',
    symbol: 'USD1',
    decimals: 6,
    supply: '1000000000000000',
    totalSellA: '793100000000000',
    totalFundRaisingB: '12500000000',
  },
};
export const LAUNCHLAB_BASE_DECIMALS = 6;
const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
/** LaunchLab now graduates every pool to Raydium CPMM. */
const MIGRATE_CPMM = 1;
const INITIALIZE_V2 = [67, 153, 175, 39, 218, 16, 38, 32];
const BUY_EXACT_IN = [250, 234, 13, 123, 213, 156, 19, 236];

const utf8 = new TextEncoder(),
  encoder = getAddressEncoder();

export type LaunchLabInput = {
  venue: LaunchLabVenue;
  name: string;
  symbol: string;
  uri: string;
  payer: string;
  mint: string;
  quoteMint: string;
  platformId: string;
  configId: string;
  supply: string;
  totalSellA: string;
  totalFundRaisingB: string;
  allowConfig: boolean;
  curveRule: boolean;
  /** Raw quote units spent by the creator in the same transaction; "0" creates only. */
  devBuyRaw: string;
  /** Minimum raw base tokens the creator receives. Ignored when devBuyRaw is "0". */
  minTokensOutRaw: string;
  blockhash: string;
  lastValidBlockHeight: string;
};
const INPUT_KEYS: (keyof LaunchLabInput)[] = [
  'venue',
  'name',
  'symbol',
  'uri',
  'payer',
  'mint',
  'quoteMint',
  'platformId',
  'configId',
  'supply',
  'totalSellA',
  'totalFundRaisingB',
  'allowConfig',
  'curveRule',
  'devBuyRaw',
  'minTokensOutRaw',
  'blockhash',
  'lastValidBlockHeight',
];

export const isLaunchLabVenue = (v: unknown): v is LaunchLabVenue =>
  typeof v === 'string' && (LAUNCHLAB_VENUES as readonly string[]).includes(v);

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
    throw new Error(`LaunchLab ${field} must be a whole raw amount.`);
  const v = BigInt(value);
  if (v > u64Max || (!allowZero && v === 0n))
    throw new Error(`LaunchLab ${field} is out of range.`);
  return v;
}
const key = (a: Address) => Uint8Array.from(encoder.encode(a));

export async function metadataAccount(mint: string) {
  return (
    await getProgramDerivedAddress({
      programAddress: address(METADATA_PROGRAM),
      seeds: [
        utf8.encode('metadata'),
        key(address(METADATA_PROGRAM)),
        key(address(mint)),
      ],
    })
  )[0];
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
const { READONLY, WRITABLE, WRITABLE_SIGNER } = AccountRole;

/** Unsigned create (+ optional same-transaction creator buy). Signers: payer and new mint. */
export async function buildLaunchLabMessage(supplied: LaunchLabInput) {
  if (
    !supplied ||
    typeof supplied !== 'object' ||
    Object.keys(supplied).sort().join() !== [...INPUT_KEYS].sort().join()
  )
    throw new Error('Unsupported LaunchLab launch option.');
  const input = structuredClone(supplied);
  if (!isLaunchLabVenue(input.venue))
    throw new Error('Unsupported LaunchLab venue.');
  const payer = address(input.payer),
    mint = address(input.mint),
    quoteMint = address(input.quoteMint);
  if (
    [payer, mint].some((a) => isOffCurveAddress(a) || a === SYSTEM) ||
    payer === mint ||
    quoteMint === mint
  )
    throw new Error(
      `${input.venue} payer and new mint need distinct wallet-controlled signing keys.`,
    );
  if (input.platformId !== LAUNCHLAB_PLATFORMS[input.venue])
    throw new Error(
      `Only the registered ${input.venue} platform is supported.`,
    );
  const curve = LAUNCHLAB_CURVES[quoteMint];
  if (!curve)
    throw new Error(`${input.venue} has no reviewed curve for this quote.`);
  const configId = await stonkConfigId(quoteMint);
  if (input.configId !== configId || configId !== curve.configId)
    throw new Error('LaunchLab curve config does not match this quote mint.');
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
  const supply = u64(input.supply, 'supply'),
    totalSellA = u64(input.totalSellA, 'curve sale amount'),
    raise = u64(input.totalFundRaisingB, 'raise'),
    devBuy = u64(input.devBuyRaw, 'creator buy', true),
    minOut = u64(input.minTokensOutRaw, 'minimum tokens', true);
  if (
    input.supply !== curve.supply ||
    input.totalSellA !== curve.totalSellA ||
    input.totalFundRaisingB !== curve.totalFundRaisingB
  )
    throw new Error('LaunchLab curve differs from the reviewed defaults.');
  if (totalSellA >= supply) throw new Error('Curve sale exceeds supply.');
  if (devBuy > 0n && (minOut === 0n || minOut > totalSellA))
    throw new Error(
      'Creator buy needs a minimum output within the curve sale.',
    );
  if (devBuy === 0n && minOut !== 0n)
    throw new Error('A create-only launch has no minimum output.');
  if (
    typeof input.allowConfig !== 'boolean' ||
    typeof input.curveRule !== 'boolean'
  )
    throw new Error('LaunchLab platform account flags differ.');
  const lifetime = u64(input.lastValidBlockHeight, 'blockhash lifetime');
  if (lifetime > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('LaunchLab blockhash lifetime differs.');

  const accounts = await stonkLaunchAddresses(
    mint,
    quoteMint,
    input.platformId,
    payer,
  );
  if (accounts.auth !== LAUNCHLAB_AUTH)
    throw new Error('LaunchLab authority differs.');
  const metadataId = await metadataAccount(mint);
  const quoteProgram = address(TOKEN_PROGRAM);
  const createMetas = [
    meta(payer, WRITABLE_SIGNER),
    meta(payer, READONLY),
    meta(configId, READONLY),
    meta(input.platformId, READONLY),
    meta(accounts.auth, READONLY),
    meta(accounts.pool, WRITABLE),
    meta(mint, WRITABLE_SIGNER),
    meta(quoteMint, READONLY),
    meta(accounts.vaultA, WRITABLE),
    meta(accounts.vaultB, WRITABLE),
    meta(metadataId, WRITABLE),
    meta(TOKEN_PROGRAM, READONLY),
    meta(quoteProgram, READONLY),
    meta(METADATA_PROGRAM, READONLY),
    meta(SYSTEM, READONLY),
    meta(RENT_SYSVAR, READONLY),
    meta(accounts.eventAuthority, READONLY),
    meta(LAUNCHLAB_PROGRAM, READONLY),
  ];
  if (input.allowConfig)
    createMetas.push(
      meta(await stonkAllowConfigId(input.platformId, configId), READONLY),
    );
  if (input.curveRule)
    createMetas.push(
      meta(await stonkCurveRuleId(input.platformId, configId), READONLY),
    );
  const createData = concat([
    Uint8Array.from(INITIALIZE_V2),
    Uint8Array.of(LAUNCHLAB_BASE_DECIMALS),
    borshString(input.name),
    borshString(input.symbol),
    borshString(input.uri),
    // ConstantCurve: index 0, supply, totalSellA, totalFundRaisingB, migrateType.
    Uint8Array.of(0),
    le64(supply),
    le64(totalSellA),
    le64(raise),
    Uint8Array.of(MIGRATE_CPMM),
    // No vesting; creator fees in the quote token only (SDK default).
    le64(0n),
    le64(0n),
    le64(0n),
    Uint8Array.of(0),
  ]);
  const budgetData = new Uint8Array(5);
  budgetData[0] = 2;
  new DataView(budgetData.buffer).setUint32(
    1,
    devBuy > 0n ? 600000 : 300000,
    true,
  );
  // A wrapped-SOL creator buy has six instructions, so the runtime default
  // (200k units each) already covers it; leaving the budget out keeps the
  // packet within 1232 bytes. Simulation confirms the units either way.
  const instructions: Instruction[] =
    devBuy > 0n && quoteMint === WRAPPED_SOL
      ? []
      : [{ programAddress: address(COMPUTE_BUDGET), data: budgetData }];
  instructions.push({
    programAddress: address(LAUNCHLAB_PROGRAM),
    accounts: createMetas,
    data: createData,
  });
  let baseAta: Address | null = null;
  if (devBuy > 0n) {
    [baseAta] = await findAssociatedTokenPda({
      mint,
      owner: payer,
      tokenProgram: address(TOKEN_PROGRAM),
    });
    const [quoteAta] = await findAssociatedTokenPda({
      mint: quoteMint,
      owner: payer,
      tokenProgram: quoteProgram,
    });
    const ataCreate = (ata: Address, m: Address): Instruction => ({
      programAddress: address(ATA_PROGRAM),
      accounts: [
        meta(payer, WRITABLE_SIGNER),
        meta(ata, WRITABLE),
        meta(payer, READONLY),
        meta(m, READONLY),
        meta(SYSTEM, READONLY),
        meta(TOKEN_PROGRAM, READONLY),
      ],
      // Idempotent: the quote account may already exist.
      data: Uint8Array.of(1),
    });
    instructions.push(ataCreate(baseAta, mint));
    const wrapped = quoteMint === WRAPPED_SOL;
    if (wrapped) {
      const transfer = new Uint8Array(12);
      new DataView(transfer.buffer).setUint32(0, 2, true);
      new DataView(transfer.buffer).setBigUint64(4, devBuy, true);
      instructions.push(
        ataCreate(quoteAta, quoteMint),
        {
          programAddress: address(SYSTEM),
          accounts: [meta(payer, WRITABLE_SIGNER), meta(quoteAta, WRITABLE)],
          data: transfer,
        },
        {
          programAddress: quoteProgram,
          accounts: [meta(quoteAta, WRITABLE)],
          data: Uint8Array.of(17),
        },
      );
    }
    instructions.push({
      programAddress: address(LAUNCHLAB_PROGRAM),
      accounts: [
        meta(payer, WRITABLE_SIGNER),
        meta(accounts.auth, READONLY),
        meta(configId, READONLY),
        meta(input.platformId, READONLY),
        meta(accounts.pool, WRITABLE),
        meta(baseAta, WRITABLE),
        meta(quoteAta, WRITABLE),
        meta(accounts.vaultA, WRITABLE),
        meta(accounts.vaultB, WRITABLE),
        meta(mint, READONLY),
        meta(quoteMint, READONLY),
        meta(TOKEN_PROGRAM, READONLY),
        meta(quoteProgram, READONLY),
        meta(accounts.eventAuthority, READONLY),
        meta(LAUNCHLAB_PROGRAM, READONLY),
        meta(SYSTEM, READONLY),
        meta(accounts.platformFeeVault, WRITABLE),
        meta(accounts.creatorFeeVault, WRITABLE),
      ],
      data: concat([
        Uint8Array.from(BUY_EXACT_IN),
        le64(devBuy),
        le64(minOut),
        le64(0n),
      ]),
    });
    if (wrapped)
      instructions.push({
        programAddress: quoteProgram,
        accounts: [
          meta(quoteAta, WRITABLE),
          meta(payer, WRITABLE),
          meta(payer, WRITABLE_SIGNER),
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
    throw new Error('LaunchLab launch signer set differs.');
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
    format: 'launchlab-platform-unsigned-v1' as const,
    venue: input.venue,
    payer,
    mint,
    quoteMint,
    pool: accounts.pool,
    configId,
    containsCreatorBuy: devBuy > 0n,
    transaction: getBase64Decoder().decode(bytes),
    packetSha256: await hash(bytes),
    packetBytes: bytes.length,
    baseTokenAccount: baseAta,
    instructions,
  };
}
