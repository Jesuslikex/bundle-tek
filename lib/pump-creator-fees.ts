import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  AccountRole,
  address,
  blockhash as parseBlockhash,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  getCompiledTransactionMessageEncoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  isOffCurveAddress,
  pipe,
  type Instruction,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
} from '@solana-program/token';
import schema from './pump-creator-fee-schema.json';
import { verifySolanaSignature } from './solana-signature';
import { UUID } from './wallet-operation';
import type { VaultSession } from './browser-wallet-vault';

export const PUMP_PROGRAM = schema.programs.pump.program;
export const PUMP_AMM_PROGRAM = schema.programs.pump_amm.program;
export const CLAIM_SYSTEM = '11111111111111111111111111111111';
export const CLAIM_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const CLAIM_TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const CLAIM_ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const CLAIM_WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = [CLAIM_TOKEN, CLAIM_TOKEN_2022];
const PACKET_LIMIT = 1232;
const MAX_VAULTS = 6;

/** Where a creator's fees accrue. Vaults are keyed by creator wallet, not by coin. */
export type CreatorFeeVaultKind = 'pump-sol' | 'pump-token' | 'amm-token';
export type CreatorFeeVault = {
  kind: CreatorFeeVaultKind;
  /** Native SOL for pump-sol; otherwise the quote token mint. */
  quoteMint: string;
  tokenProgram: string | null;
  decimals: number;
  /** Account holding the fees (vault PDA or vault token account). */
  vault: string;
  /** Wallet-owned receiving account (the wallet itself for pump-sol). */
  destination: string;
  claimableRaw: string;
};
export type CreatorFeeClaimReview = {
  format: 'pump-creator-fee-claim-v1';
  id: string;
  network: 'mainnet';
  wallet: string;
  walletRevision: number;
  vaults: CreatorFeeVault[];
  /** Receiving token accounts this packet creates (idempotent creation is always included). */
  newAccounts: string[];
  /** Close the freshly created WSOL account so PumpSwap SOL fees arrive as native SOL. */
  unwrapNative: boolean;
  feeLamports: string;
  /** Rent the wallet keeps paying for newly created receiving accounts (refunded for unwrapped WSOL). */
  accountRentLamports: string;
  blockhash: string;
  lastValidBlockHeight: string;
  slot: number;
  transaction: string;
  sha256: string;
  preparedAt: string;
  expiresAt: string;
  source: string;
  simulation: {
    walletChangeLamports: string;
    tokens: { mint: string; account: string; changeRaw: string }[];
  };
};
export type CreatorFeeClaimReceipt = {
  network: 'mainnet';
  commitment: 'finalized';
  signature: string;
  wallet: string;
  failed: boolean;
  error: string | null;
  networkFeeLamports: string;
  walletChangeLamports: string;
  tokens: { mint: string; account: string; changeRaw: string }[];
  slot: number;
  blockTime: number | null;
  sha256: string;
  observedAt: string;
  source: string;
};

const utf8 = new TextEncoder(),
  addressEncoder = getAddressEncoder();
export const encodeBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
};
export const decodeBase64 = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    value.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error('Invalid creator fee packet.');
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (encodeBase64(bytes) !== value)
    throw new Error('Invalid creator fee packet.');
  return bytes;
};
export const claimUint = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid creator fee integer.');
  return BigInt(value);
};
const signedInt = (value: unknown) => {
  if (typeof value !== 'string' || !/^(0|-?[1-9]\d{0,20})$/.test(value))
    throw new Error('Invalid creator fee change.');
  return BigInt(value);
};
export const sha256Hex = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');

const pda = async (program: string, seed: string, key?: string) =>
  (
    await getProgramDerivedAddress({
      programAddress: address(program),
      seeds: [
        utf8.encode(seed),
        ...(key ? [addressEncoder.encode(address(key))] : []),
      ],
    })
  )[0] as string;
const ata = async (owner: string, mint: string, tokenProgram: string) =>
  (
    await findAssociatedTokenPda({
      owner: address(owner),
      mint: address(mint),
      tokenProgram: address(tokenProgram),
    })
  )[0] as string;

/** Pump's creator vault PDAs for one wallet. */
export async function creatorFeeAddresses(wallet: string) {
  return {
    pumpVault: await pda(PUMP_PROGRAM, 'creator-vault', wallet),
    ammAuthority: await pda(PUMP_AMM_PROGRAM, 'creator_vault', wallet),
    pumpEvents: await pda(PUMP_PROGRAM, '__event_authority'),
    ammEvents: await pda(PUMP_AMM_PROGRAM, '__event_authority'),
  };
}
/** Adds the vault and receiving token accounts for one quote mint. */
export async function creatorFeeQuoteAddresses(
  wallet: string,
  quote: { mint: string; tokenProgram: string },
) {
  if (!TOKEN_PROGRAMS.includes(quote.tokenProgram))
    throw new Error('Unsupported creator fee token program.');
  const base = await creatorFeeAddresses(wallet);
  return {
    ...base,
    pumpTokenVault: await ata(base.pumpVault, quote.mint, quote.tokenProgram),
    ammTokenVault: await ata(base.ammAuthority, quote.mint, quote.tokenProgram),
    destination: await ata(wallet, quote.mint, quote.tokenProgram),
  };
}

type SchemaInstruction = (typeof schema.programs.pump.instructions)[number];
const pinned = (program: 'pump' | 'pump_amm', name: string) => {
  const found = (
    schema.programs[program].instructions as SchemaInstruction[]
  ).find((i) => i.name === name);
  if (!found || found.args.length) throw new Error('Pinned layout missing.');
  return found;
};
// Account order and writability come from the pinned IDL subset, not from hand-written lists.
function pinnedInstruction(
  program: 'pump' | 'pump_amm',
  name: string,
  accounts: Record<string, string>,
): Instruction {
  const layout = pinned(program, name);
  if (Object.keys(accounts).length !== layout.accounts.length)
    throw new Error('Creator fee account roles differ.');
  return {
    programAddress: address(schema.programs[program].program),
    accounts: layout.accounts.map((a) => {
      const value = accounts[a.name];
      if (!value) throw new Error('Creator fee account roles differ.');
      return {
        address: address(value),
        role: a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      };
    }),
    data: Uint8Array.from(layout.discriminator),
  };
}

function validVault(v: CreatorFeeVault) {
  if (
    !v ||
    !['pump-sol', 'pump-token', 'amm-token'].includes(v.kind) ||
    !Number.isInteger(v.decimals) ||
    v.decimals < 0 ||
    v.decimals > 18
  )
    throw new Error('Creator fee vault differs.');
  address(v.quoteMint);
  address(v.vault);
  address(v.destination);
  if (v.kind === 'pump-sol') {
    if (
      v.quoteMint !== CLAIM_WSOL ||
      v.tokenProgram !== null ||
      v.decimals !== 9
    )
      throw new Error('Creator SOL vault differs.');
  } else if (
    !v.tokenProgram ||
    !TOKEN_PROGRAMS.includes(v.tokenProgram) ||
    (v.kind === 'pump-token' && v.quoteMint === CLAIM_WSOL) ||
    (v.quoteMint === CLAIM_WSOL && v.tokenProgram !== CLAIM_TOKEN)
  )
    throw new Error('Creator token vault differs.');
  if (claimUint(v.claimableRaw) === 0n)
    throw new Error('Creator fee vault has nothing to claim.');
}
/** The PumpSwap WSOL vault, whose receiving account may be unwrapped to native SOL. */
export const wsolTokenVault = (vaults: CreatorFeeVault[]) =>
  vaults.find((v) => v.quoteMint === CLAIM_WSOL && v.kind !== 'pump-sol');
export const vaultKey = (v: Pick<CreatorFeeVault, 'kind' | 'quoteMint'>) =>
  `${v.kind}:${v.quoteMint}`;

/** Unsigned legacy packet: idempotent receiving accounts, one collect per vault, optional WSOL unwrap. */
export async function buildCreatorFeeClaimMessage(input: {
  wallet: string;
  vaults: CreatorFeeVault[];
  unwrapNative: boolean;
  blockhash: string;
  lastValidBlockHeight: bigint;
}) {
  const wallet = address(input.wallet);
  if (isOffCurveAddress(wallet) || wallet === CLAIM_SYSTEM)
    throw new Error('Choose an ordinary signing wallet.');
  if (
    !Array.isArray(input.vaults) ||
    !input.vaults.length ||
    input.vaults.length > MAX_VAULTS ||
    new Set(input.vaults.map(vaultKey)).size !== input.vaults.length
  )
    throw new Error('Choose between one and six distinct creator fee vaults.');
  const instructions: Instruction[] = [];
  const created: { account: string; mint: string; tokenProgram: string }[] = [];
  const collects: Instruction[] = [];
  for (const v of input.vaults) {
    validVault(v);
    if (v.kind === 'pump-sol') {
      const a = await creatorFeeAddresses(wallet);
      if (v.vault !== a.pumpVault || v.destination !== wallet)
        throw new Error('Creator SOL vault address differs.');
      collects.push(
        pinnedInstruction('pump', 'collect_creator_fee', {
          creator: wallet,
          creator_vault: a.pumpVault,
          system_program: CLAIM_SYSTEM,
          event_authority: a.pumpEvents,
          program: PUMP_PROGRAM,
        }),
      );
      continue;
    }
    const a = await creatorFeeQuoteAddresses(wallet, {
      mint: v.quoteMint,
      tokenProgram: v.tokenProgram!,
    });
    const expectedVault =
      v.kind === 'pump-token' ? a.pumpTokenVault : a.ammTokenVault;
    if (v.vault !== expectedVault || v.destination !== a.destination)
      throw new Error('Creator token vault address differs.');
    if (!created.some((c) => c.account === a.destination))
      created.push({
        account: a.destination,
        mint: v.quoteMint,
        tokenProgram: v.tokenProgram!,
      });
    collects.push(
      v.kind === 'pump-token'
        ? pinnedInstruction('pump', 'collect_creator_fee_v2', {
            creator: wallet,
            creator_token_account: a.destination,
            creator_vault: a.pumpVault,
            creator_vault_token_account: a.pumpTokenVault,
            quote_mint: v.quoteMint,
            quote_token_program: v.tokenProgram!,
            associated_token_program: CLAIM_ATA,
            system_program: CLAIM_SYSTEM,
            event_authority: a.pumpEvents,
            program: PUMP_PROGRAM,
          })
        : pinnedInstruction('pump_amm', 'collect_coin_creator_fee', {
            quote_mint: v.quoteMint,
            quote_token_program: v.tokenProgram!,
            coin_creator: wallet,
            coin_creator_vault_authority: a.ammAuthority,
            coin_creator_vault_ata: a.ammTokenVault,
            coin_creator_token_account: a.destination,
            event_authority: a.ammEvents,
            program: PUMP_AMM_PROGRAM,
          }),
    );
  }
  const payer = createNoopSigner(wallet);
  for (const c of created)
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: address(c.account),
        owner: wallet,
        mint: address(c.mint),
        tokenProgram: address(c.tokenProgram),
      }),
    );
  instructions.push(...collects);
  const wsol = created.find((c) => c.mint === CLAIM_WSOL);
  if (input.unwrapNative) {
    if (!wsol) throw new Error('No WSOL receiving account to unwrap.');
    instructions.push(
      getCloseAccountInstruction({
        account: address(wsol.account),
        destination: wallet,
        owner: payer,
      }),
    );
  }
  const compiled = compileTransactionMessage(
    pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayer(wallet, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: parseBlockhash(input.blockhash),
            lastValidBlockHeight: input.lastValidBlockHeight,
          },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  if (compiled.header.numSignerAccounts !== 1)
    throw new Error('Creator fee packet must need only the wallet signature.');
  const message = Uint8Array.from(
    getCompiledTransactionMessageEncoder().encode(compiled),
  );
  if (1 + 64 + message.length > PACKET_LIMIT)
    throw new Error('Too many vaults for one packet. Claim fewer at once.');
  return {
    message,
    accountKeys: compiled.staticAccounts as string[],
    receivingAccounts: created.map((c) => c.account),
  };
}

/** Rebuilds the reviewed packet and checks every byte, plus the wallet signature when signed. */
export async function inspectCreatorFeeClaim(
  review: CreatorFeeClaimReview,
  transaction: string,
  signed: boolean,
) {
  if (
    !review ||
    review.format !== 'pump-creator-fee-claim-v1' ||
    !UUID.test(review.id) ||
    review.network !== 'mainnet' ||
    !Number.isSafeInteger(review.walletRevision) ||
    review.walletRevision < 1 ||
    !Number.isSafeInteger(review.slot) ||
    review.slot < 0 ||
    typeof review.unwrapNative !== 'boolean' ||
    !Array.isArray(review.newAccounts) ||
    !Number.isFinite(Date.parse(review.preparedAt)) ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    Date.parse(review.expiresAt) <= Date.parse(review.preparedAt) ||
    Date.parse(review.expiresAt) - Date.parse(review.preparedAt) > 60000 ||
    !/^[a-f0-9]{64}$/.test(review.sha256)
  )
    throw new Error('Creator fee review differs.');
  claimUint(review.feeLamports);
  claimUint(review.accountRentLamports);
  const built = await buildCreatorFeeClaimMessage({
    wallet: review.wallet,
    vaults: review.vaults,
    unwrapNative: review.unwrapNative,
    blockhash: review.blockhash,
    lastValidBlockHeight: claimUint(review.lastValidBlockHeight),
  });
  if (
    review.newAccounts.some((a) => !built.receivingAccounts.includes(a)) ||
    new Set(review.newAccounts).size !== review.newAccounts.length ||
    (review.unwrapNative &&
      !review.newAccounts.includes(
        wsolTokenVault(review.vaults)?.destination ?? '',
      ))
  )
    throw new Error('Creator fee receiving accounts differ.');
  const sim = review.simulation;
  if (
    !sim ||
    !Array.isArray(sim.tokens) ||
    signedInt(sim.walletChangeLamports) <
      -(
        claimUint(review.feeLamports) + claimUint(review.accountRentLamports)
      ) ||
    sim.tokens.some(
      (t) =>
        !built.receivingAccounts.includes(t.account) ||
        signedInt(t.changeRaw) < 0n,
    )
  )
    throw new Error('Creator fee simulation differs.');
  const message = built.message,
    unsigned = Uint8Array.from([1, ...new Uint8Array(64), ...message]),
    bytes = decodeBase64(transaction);
  if (
    bytes.length !== unsigned.length ||
    bytes[0] !== 1 ||
    bytes.slice(65).some((b, i) => b !== message[i]) ||
    (await sha256Hex(unsigned)) !== review.sha256 ||
    encodeBase64(unsigned) !== review.transaction
  )
    throw new Error('Creator fee packet differs from its exact review.');
  const signature = bytes.slice(1, 65);
  if (
    signed
      ? !verifySolanaSignature(message, signature, bs58.decode(review.wallet))
      : signature.some((b) => b !== 0)
  )
    throw new Error('Invalid creator fee wallet signature.');
  return {
    bytes,
    message,
    accountKeys: built.accountKeys,
    receivingAccounts: built.receivingAccounts,
    signature: signed ? bs58.encode(signature) : null,
  };
}

/** Browser-only: signs the exact reviewed packet with the vault wallet and clears key bytes. */
export async function signCreatorFeeClaim(
  session: VaultSession,
  review: CreatorFeeClaimReview,
  assertCurrent: () => void,
) {
  const { message } = await inspectCreatorFeeClaim(
    review,
    review.transaction,
    false,
  );
  assertCurrent();
  const wallet = session.payload.wallets.find(
    (w) => w.family === 'solana' && w.address === review.wallet,
  );
  if (!wallet || !/^[a-f0-9]{64}$/.test(wallet.seed))
    throw new Error('Reviewed wallet is not in this vault.');
  const seed = Uint8Array.from(wallet.seed.match(/../g)!, (s) =>
      parseInt(s, 16),
    ),
    pair = nacl.sign.keyPair.fromSeed(seed);
  try {
    assertCurrent();
    if (
      Date.parse(review.expiresAt) <= Date.now() ||
      bs58.encode(pair.publicKey) !== review.wallet
    )
      throw new Error('Creator fee approval expired or changed.');
    const signature = nacl.sign.detached(message, pair.secretKey);
    const transaction = encodeBase64(
      Uint8Array.from([1, ...signature, ...message]),
    );
    assertCurrent();
    return { signature: bs58.encode(signature), transaction };
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
}

type RawTokenBalance = {
  accountIndex: string | number;
  mint: string;
  uiTokenAmount: { amount: string };
};
/** Decodes a finalized getTransaction result for the exact signed packet. */
export async function decodeCreatorFeeClaimReceipt(
  raw: unknown,
  review: CreatorFeeClaimReview,
  signature: string,
  source: string,
): Promise<CreatorFeeClaimReceipt> {
  const result = raw as {
    slot: string;
    blockTime: string | null;
    version: 'legacy';
    transaction: [string, string];
    meta: {
      err: unknown;
      fee: string;
      preBalances: string[];
      postBalances: string[];
      preTokenBalances?: RawTokenBalance[];
      postTokenBalances?: RawTokenBalance[];
    };
  };
  if (
    !result ||
    result.version !== 'legacy' ||
    !Array.isArray(result.transaction) ||
    result.transaction[1] !== 'base64' ||
    !result.meta ||
    result.meta.err === undefined ||
    Number(claimUint(result.slot)) < review.slot
  )
    throw new Error('Finalized creator fee receipt unavailable.');
  const signed = await inspectCreatorFeeClaim(
    review,
    result.transaction[0],
    true,
  );
  if (signed.signature !== signature)
    throw new Error('Finalized creator fee signature differs.');
  const meta = result.meta,
    keys = signed.accountKeys;
  if (
    !Array.isArray(meta.preBalances) ||
    !Array.isArray(meta.postBalances) ||
    meta.preBalances.length !== keys.length ||
    meta.postBalances.length !== keys.length
  )
    throw new Error('Creator fee receipt balances differ.');
  const fee = claimUint(meta.fee),
    walletChange =
      claimUint(meta.postBalances[0]) - claimUint(meta.preBalances[0]);
  const amount = (list: RawTokenBalance[] | undefined, account: string) => {
    const index = keys.indexOf(account);
    const row = (list ?? []).find((b) => Number(b.accountIndex) === index);
    return row ? claimUint(row.uiTokenAmount?.amount) : 0n;
  };
  const failed = meta.err !== null;
  const tokens = signed.receivingAccounts.map((account) => {
    const vault = review.vaults.find((v) => v.destination === account)!;
    return {
      mint: vault.quoteMint,
      account,
      changeRaw: (
        amount(meta.postTokenBalances, account) -
        amount(meta.preTokenBalances, account)
      ).toString(),
    };
  });
  if (
    fee > claimUint(review.feeLamports) ||
    (failed
      ? walletChange !== -fee
      : walletChange < -(fee + claimUint(review.accountRentLamports)) ||
        tokens.some((t) => BigInt(t.changeRaw) < 0n))
  )
    throw new Error('Finalized creator fee settlement differs.');
  return {
    network: 'mainnet',
    commitment: 'finalized',
    signature,
    wallet: review.wallet,
    failed,
    error: failed ? JSON.stringify(meta.err).slice(0, 300) : null,
    networkFeeLamports: fee.toString(),
    walletChangeLamports: walletChange.toString(),
    tokens,
    slot: Number(claimUint(result.slot)),
    blockTime:
      result.blockTime === null ? null : Number(claimUint(result.blockTime)),
    sha256: review.sha256,
    observedAt: new Date().toISOString(),
    source,
  };
}
