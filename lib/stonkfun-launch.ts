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

/**
 * StonkFun launches are Raydium LaunchLab pools created under StonkFun's
 * platform config (https://www.stonkfun.xyz/developers). Instruction layouts
 * follow the official @raydium-io/raydium-sdk-v2 launchpad encoders; the
 * golden test pins byte equality with that SDK.
 */
export const LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const LAUNCHLAB_AUTH = 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh';
/** Untaxed StonkFun platform. Reward/community modes are not supported yet. */
export const STONKFUN_STANDARD_PLATFORM =
  '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const SYSTEM = '11111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const STONKFUN_BASE_DECIMALS = 6;
export const STONKFUN_MAX_DEV_SUPPLY_BPS = 5000n;
/** Raydium launchpad CPMM migration; StonkFun's adopted shape uses cpmm. */
const MIGRATE_CPMM = 1;

const INITIALIZE_WITH_TOKEN_2022 = [37, 190, 126, 222, 44, 154, 171, 17];
const BUY_EXACT_IN = [250, 234, 13, 123, 213, 156, 19, 236];

const utf8 = new TextEncoder(),
  encoder = getAddressEncoder();

export type StonkLaunchInput = {
  name: string;
  symbol: string;
  uri: string;
  payer: string;
  mint: string;
  quoteMint: string;
  quoteTokenProgram: string;
  platformId: string;
  configId: string;
  supply: string;
  totalSellA: string;
  totalFundRaisingB: string;
  cpmmCreatorFeeOn: number;
  allowConfig: boolean;
  curveRule: boolean;
  /** Raw quote units spent by the creator in the same transaction; "0" creates only. */
  devBuyRaw: string;
  /** Minimum raw base tokens the creator receives. Ignored when devBuyRaw is "0". */
  minTokensOutRaw: string;
  blockhash: string;
  lastValidBlockHeight: string;
};
const INPUT_KEYS: (keyof StonkLaunchInput)[] = [
  'name',
  'symbol',
  'uri',
  'payer',
  'mint',
  'quoteMint',
  'quoteTokenProgram',
  'platformId',
  'configId',
  'supply',
  'totalSellA',
  'totalFundRaisingB',
  'cpmmCreatorFeeOn',
  'allowConfig',
  'curveRule',
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
    throw new Error(`StonkFun ${field} must be a whole raw amount.`);
  const v = BigInt(value);
  if (v > u64Max || (!allowZero && v === 0n))
    throw new Error(`StonkFun ${field} is out of range.`);
  return v;
}

const program = () => address(LAUNCHLAB_PROGRAM);
async function pda(seeds: Uint8Array[]) {
  return (
    await getProgramDerivedAddress({ programAddress: program(), seeds })
  )[0];
}
const seed = (s: string) => utf8.encode(s);
const key = (a: Address) => Uint8Array.from(encoder.encode(a));

/** global_config PDA for a quote mint, ConstantCurve (0), index 0. */
export function stonkConfigId(quoteMint: string) {
  return pda([
    seed('global_config'),
    key(address(quoteMint)),
    Uint8Array.of(0),
    Uint8Array.of(0, 0),
  ]);
}
export function stonkAllowConfigId(platformId: string, configId: string) {
  return pda([
    seed('platform_allow_config'),
    key(address(platformId)),
    key(address(configId)),
  ]);
}
export function stonkCurveRuleId(platformId: string, configId: string) {
  return pda([
    seed('platform_curve_rule'),
    key(address(platformId)),
    key(address(configId)),
  ]);
}

export async function stonkLaunchAddresses(
  mintValue: string,
  quoteMintValue: string,
  platformId: string,
  creator: string,
) {
  const mint = address(mintValue),
    quoteMint = address(quoteMintValue);
  const pool = await pda([seed('pool'), key(mint), key(quoteMint)]);
  return {
    auth: await pda([seed('vault_auth_seed')]),
    eventAuthority: await pda([seed('__event_authority')]),
    pool,
    vaultA: await pda([seed('pool_vault'), key(pool), key(mint)]),
    vaultB: await pda([seed('pool_vault'), key(pool), key(quoteMint)]),
    platformFeeVault: await pda([key(address(platformId)), key(quoteMint)]),
    creatorFeeVault: await pda([key(address(creator)), key(quoteMint)]),
  };
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
function le(value: bigint, bytes: number) {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  if (bytes === 8) view.setBigUint64(0, value, true);
  else if (bytes === 2) view.setUint16(0, Number(value), true);
  else out[0] = Number(value);
  return out;
}
const meta = (a: Address | string, role: AccountRole) => ({
  address: address(a),
  role,
});
const { READONLY, WRITABLE, WRITABLE_SIGNER } = AccountRole;

/** Unsigned create (+ optional same-transaction creator buy). Signers: payer and new mint. */
export async function buildStonkLaunchMessage(supplied: StonkLaunchInput) {
  if (
    !supplied ||
    typeof supplied !== 'object' ||
    Object.keys(supplied).sort().join() !== [...INPUT_KEYS].sort().join()
  )
    throw new Error('Unsupported StonkFun launch option.');
  const input = structuredClone(supplied);
  const payer = address(input.payer),
    mint = address(input.mint),
    quoteMint = address(input.quoteMint),
    quoteProgram = address(input.quoteTokenProgram);
  if (
    [payer, mint].some((a) => isOffCurveAddress(a) || a === SYSTEM) ||
    payer === mint ||
    quoteMint === mint
  )
    throw new Error(
      'StonkFun payer and new mint need distinct wallet-controlled signing keys.',
    );
  if (input.platformId !== STONKFUN_STANDARD_PLATFORM)
    throw new Error('Only the standard StonkFun platform is supported.');
  if (![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(quoteProgram))
    throw new Error('StonkFun quote token program differs.');
  if (quoteMint === WRAPPED_SOL && quoteProgram !== TOKEN_PROGRAM)
    throw new Error('Wrapped SOL uses the classic token program.');
  const configId = await stonkConfigId(quoteMint);
  if (input.configId !== configId)
    throw new Error('StonkFun curve config does not match this quote mint.');
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
        'StonkFun launch identity exceeds its byte limits or contains control characters.',
      );
  const metadata = new URL(input.uri);
  if (
    metadata.protocol !== 'https:' ||
    metadata.username ||
    metadata.password ||
    metadata.hash
  )
    throw new Error('Review an HTTPS metadata URI before a StonkFun launch.');
  const supply = u64(input.supply, 'supply'),
    totalSellA = u64(input.totalSellA, 'curve sale amount'),
    raise = u64(input.totalFundRaisingB, 'raise'),
    devBuy = u64(input.devBuyRaw, 'creator buy', true),
    minOut = u64(input.minTokensOutRaw, 'minimum tokens', true);
  if (totalSellA >= supply)
    throw new Error('StonkFun curve sale exceeds supply.');
  if (
    devBuy > 0n &&
    (minOut === 0n || minOut * 10000n > supply * STONKFUN_MAX_DEV_SUPPLY_BPS)
  )
    throw new Error(
      'StonkFun creator buy needs a minimum output within 50% of supply.',
    );
  if (devBuy === 0n && minOut !== 0n)
    throw new Error('A create-only StonkFun launch has no minimum output.');
  if (![0, 1, 2].includes(input.cpmmCreatorFeeOn))
    throw new Error('StonkFun creator fee mode differs.');
  if (
    typeof input.allowConfig !== 'boolean' ||
    typeof input.curveRule !== 'boolean'
  )
    throw new Error('StonkFun platform account flags differ.');
  const lifetime = u64(input.lastValidBlockHeight, 'blockhash lifetime');
  if (lifetime > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('StonkFun blockhash lifetime differs.');

  const accounts = await stonkLaunchAddresses(
    mint,
    quoteMint,
    input.platformId,
    payer,
  );
  if (accounts.auth !== LAUNCHLAB_AUTH)
    throw new Error('LaunchLab authority differs.');
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
    meta(TOKEN_2022_PROGRAM, READONLY),
    meta(quoteProgram, READONLY),
    meta(SYSTEM, READONLY),
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
    Uint8Array.from(INITIALIZE_WITH_TOKEN_2022),
    Uint8Array.of(STONKFUN_BASE_DECIMALS),
    borshString(input.name),
    borshString(input.symbol),
    borshString(input.uri),
    // ConstantCurve: index 0, supply, totalSellA, totalFundRaisingB, migrateType.
    Uint8Array.of(0),
    le(supply, 8),
    le(totalSellA, 8),
    le(raise, 8),
    Uint8Array.of(MIGRATE_CPMM),
    // No vesting; creator fee mode; no transfer-fee extension (SDK writes the
    // zeroed fixed-size params after the None tag).
    le(0n, 8),
    le(0n, 8),
    le(0n, 8),
    Uint8Array.of(input.cpmmCreatorFeeOn),
    Uint8Array.of(0),
    le(0n, 2),
    le(0n, 8),
  ]);
  const instructions: Instruction[] = [];
  const budgetData = new Uint8Array(5);
  budgetData[0] = 2;
  new DataView(budgetData.buffer).setUint32(
    1,
    devBuy > 0n ? 600000 : 300000,
    true,
  );
  instructions.push({
    programAddress: address(COMPUTE_BUDGET),
    data: budgetData,
  });
  instructions.push({
    programAddress: program(),
    accounts: createMetas,
    data: createData,
  });
  if (devBuy > 0n) {
    const [baseAta] = await findAssociatedTokenPda({
      mint,
      owner: payer,
      tokenProgram: address(TOKEN_2022_PROGRAM),
    });
    const [quoteAta] = await findAssociatedTokenPda({
      mint: quoteMint,
      owner: payer,
      tokenProgram: quoteProgram,
    });
    const ataCreate = (
      ata: Address,
      m: Address,
      tokenProgram: Address,
    ): Instruction => ({
      programAddress: address(ATA_PROGRAM),
      accounts: [
        meta(payer, WRITABLE_SIGNER),
        meta(ata, WRITABLE),
        meta(payer, READONLY),
        meta(m, READONLY),
        meta(SYSTEM, READONLY),
        meta(tokenProgram, READONLY),
      ],
      data: Uint8Array.of(1),
    });
    instructions.push(ataCreate(baseAta, mint, address(TOKEN_2022_PROGRAM)));
    const wrapped = quoteMint === WRAPPED_SOL;
    if (wrapped) {
      const transfer = new Uint8Array(12);
      new DataView(transfer.buffer).setUint32(0, 2, true);
      new DataView(transfer.buffer).setBigUint64(4, devBuy, true);
      instructions.push(
        ataCreate(quoteAta, quoteMint, quoteProgram),
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
      programAddress: program(),
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
        meta(TOKEN_2022_PROGRAM, READONLY),
        meta(quoteProgram, READONLY),
        meta(accounts.eventAuthority, READONLY),
        meta(LAUNCHLAB_PROGRAM, READONLY),
        meta(SYSTEM, READONLY),
        meta(accounts.platformFeeVault, WRITABLE),
        meta(accounts.creatorFeeVault, WRITABLE),
      ],
      data: concat([
        Uint8Array.from(BUY_EXACT_IN),
        le(devBuy, 8),
        le(minOut, 8),
        le(0n, 8),
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
    throw new Error('StonkFun launch signer set differs.');
  const transaction = compileTransaction(message),
    bytes = Uint8Array.from(getTransactionEncoder().encode(transaction));
  if (
    bytes.length > 1232 ||
    Object.values(transaction.signatures).some((s) => s !== null)
  )
    throw new Error(
      'StonkFun launch packet is too large. Shorten the name, symbol or metadata link.',
    );
  return {
    format: 'stonkfun-launchlab-unsigned-v1' as const,
    payer,
    mint,
    quoteMint,
    pool: accounts.pool,
    configId,
    containsCreatorBuy: devBuy > 0n,
    transaction: getBase64Decoder().decode(bytes),
    packetSha256: await hash(bytes),
    packetBytes: bytes.length,
    baseTokenAccount:
      devBuy > 0n
        ? (
            await findAssociatedTokenPda({
              mint,
              owner: payer,
              tokenProgram: address(TOKEN_2022_PROGRAM),
            })
          )[0]
        : null,
    instructions,
  };
}
