import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash as parseBlockhash,
  compileTransactionMessage,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { verifySolanaSignature } from './solana-signature';
import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import { formatNativeBalance } from './wallet-balance-format';
import { TOKEN_2022 } from './token-withdrawal-fee';
import { sendPercent, SEND_PERCENT_SCALE } from './token-send-plan';
import type { VaultSession } from './browser-wallet-vault';

// Streamflow Airdrop cleanup: one owned wallet deposits tokens into a
// Streamflow merkle distributor and the chosen output wallets each claim an
// equal share. Three transaction kinds share one lifecycle: `create` (new
// distributor plus the deposit), `claim` (one output wallet) and `clawback`
// (the creator takes back whatever was not claimed). The server prepares and
// simulates an exact unsigned packet; the browser rebuilds it byte for byte
// before the user signs it locally.
//
// Layouts follow Streamflow's published IDL (@streamflow/distributor); the
// golden test pins the bytes. The claim proof uses the leaf and node hashing
// of the Jito distributor that Streamflow's program is a fork of.

export const AIRDROP_PROGRAM = 'MErKy6nZVoVAkryxAejJz2juifQ4ArgLgHmaJCQkU7N';
export const AIRDROP_PARTNER_ORACLE =
  'pardpVtPjC8nLj1Dwncew62mUzfChdCX1EaoZe8oCAa';
export const AIRDROP_FEE_CONFIG =
  '5WHEQeA5uX7zJ8r7yAzsxomF7LTnX9acQy3V8oWXHa8b';
const SYSTEM = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const NEW_DISTRIBUTOR = [32, 139, 112, 171, 0, 2, 225, 155];
const NEW_CLAIM = [78, 177, 98, 123, 210, 21, 187, 83];
const CLAWBACK = [111, 92, 142, 79, 33, 234, 82, 27];
export const AIRDROP_MAX_RECIPIENTS = 20;
/** Claims open this long after the review is prepared, so the start is still in the future when the create lands. */
export const AIRDROP_START_DELAY_SECONDS = 180;
/** The creator can take back unclaimed tokens one day (plus a margin) after the unlock. */
export const AIRDROP_CLAWBACK_DELAY_SECONDS = 86_400 + 120;
const LIFETIME_MS = 60_000;

export type AirdropKind = 'create' | 'claim' | 'clawback';
export type AirdropTerms = {
  /** The create review's id; every claim and clawback names it. */
  airdropId: string;
  /** Distributor version (u64, decimal). With the mint it fixes the distributor address. */
  version: string;
  distributor: string;
  vault: string;
  /** Merkle root, 64 hex characters. */
  root: string;
  /** Raw token units each output wallet can claim. */
  perRecipientRaw: string;
  startTs: number;
  endTs: number;
  clawbackTs: number;
  /** The wallet that created the distributor and receives a clawback. */
  creator: string;
  /** create only: the output wallets, in tree order. */
  recipients?: string[];
  /** claim only: sibling hashes for this wallet, 64 hex characters each. */
  proof?: string[];
};
export type TokenAirdropReview = {
  id: string;
  network: 'mainnet';
  kind: AirdropKind;
  /** The signer: the creator for create and clawback, the output wallet for a claim. */
  wallet: string;
  walletRevision: number;
  mint: string;
  program: typeof TOKEN_PROGRAM_ADDRESS | typeof TOKEN_2022;
  decimals: number;
  /** The signer's own token account for this mint. */
  tokenAccount: string;
  terms: AirdropTerms;
  /** create only: share of the wallet's balance that was requested. */
  percentPpm?: string;
  /** Simulated change of the signer's token balance: negative for create, positive otherwise. */
  tokenChangeRaw: string;
  amount: string;
  blockhash: string;
  lastValidBlockHeight: string;
  slot: number;
  feeLamports: string;
  /** Lamports the simulated packet removed from the wallet (network fee, rent and any Streamflow fee). */
  solDebitLamports: string;
  reserveLamports: string;
  transaction: string;
  sha256: string;
  preparedAt: string;
  expiresAt: string;
  source: string;
};
export type TokenAirdropState =
  | 'awaiting_signature'
  | 'signing'
  | 'signed'
  | 'submitted'
  | 'finalized'
  | 'failed'
  | 'cancelled';
export type TokenAirdropReceipt = {
  network: 'mainnet';
  commitment: 'finalized';
  signature: string;
  failed: boolean;
  error: string | null;
  slot: number;
  blockTime: number | null;
  networkFeeLamports: string;
  walletLamportsChange: string;
  tokenChangeRaw: string;
  observedAt: string;
};
export type TokenAirdropAction = {
  id: string;
  airdropId: string;
  wallet: string;
  walletRevision: number;
  kind: AirdropKind;
  mint: string;
  state: TokenAirdropState;
  signature: string | null;
  document: TokenAirdropReview;
  receipt: TokenAirdropReceipt | null;
  createdAt: string;
  updatedAt: string;
};

const U64_MAX = (1n << 64n) - 1n;
export const airdropUint = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > U64_MAX
  )
    throw new Error('Invalid airdrop integer.');
  return BigInt(value);
};
const signedInt = (value: unknown) => {
  if (typeof value !== 'string' || !/^(0|-?[1-9]\d{0,19})$/.test(value))
    throw new Error('Invalid airdrop integer.');
  return BigInt(value);
};
export const airdropBase64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes));
export const airdropBytes = (value: string) => {
  if (
    typeof value !== 'string' ||
    value.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error('Invalid airdrop packet.');
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (airdropBase64(bytes) !== value)
    throw new Error('Invalid airdrop packet.');
  return bytes;
};
const sha = async (...parts: Uint8Array[]) => {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all.buffer));
};
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('Invalid airdrop hash.');
  return Uint8Array.from(value.match(/../g)!, (s) => parseInt(s, 16));
};
export const airdropSha256 = async (bytes: Uint8Array) => hex(await sha(bytes));
const u64le = (value: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};
const encoder = getAddressEncoder();
const key = (value: string) => Uint8Array.from(encoder.encode(address(value)));
const compare = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** Leaf for one claimant: everything is unlocked, nothing is vested. */
export async function airdropLeaf(claimant: string, amountRaw: bigint) {
  return sha(
    Uint8Array.of(0),
    await sha(key(claimant), u64le(amountRaw), u64le(0n)),
  );
}
const parent = (a: Uint8Array, b: Uint8Array) =>
  compare(a, b) <= 0
    ? sha(Uint8Array.of(1), a, b)
    : sha(Uint8Array.of(1), b, a);
/** The program's own check: fold the proof into the leaf with sorted, prefixed pairs. */
export async function airdropProofRoot(leaf: Uint8Array, proof: Uint8Array[]) {
  let node = leaf;
  for (const sibling of proof) node = await parent(node, sibling);
  return node;
}
/** Root and one proof per recipient. An unpaired node moves up unchanged. */
export async function airdropTree(recipients: string[], amountRaw: bigint) {
  if (recipients.length < 1) throw new Error('Choose at least one recipient.');
  let level: Uint8Array[] = await Promise.all(
    recipients.map((r) => airdropLeaf(r, amountRaw)),
  );
  const proofs: Uint8Array[][] = recipients.map(() => []);
  let groups = recipients.map((_, i) => [i]);
  while (level.length > 1) {
    const next: Uint8Array[] = [],
      nextGroups: number[][] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]);
        nextGroups.push(groups[i]);
        continue;
      }
      for (const leaf of groups[i]) proofs[leaf].push(level[i + 1]);
      for (const leaf of groups[i + 1]) proofs[leaf].push(level[i]);
      next.push(await parent(level[i], level[i + 1]));
      nextGroups.push([...groups[i], ...groups[i + 1]]);
    }
    level = next;
    groups = nextGroups;
  }
  return {
    root: hex(level[0]),
    proofs: proofs.map((p) => p.map(hex)),
  };
}

export async function airdropAccounts(input: {
  mint: string;
  program: string;
  version: bigint;
}) {
  const [distributor] = await getProgramDerivedAddress({
    programAddress: address(AIRDROP_PROGRAM),
    seeds: [
      new TextEncoder().encode('MerkleDistributor'),
      key(input.mint),
      u64le(input.version),
    ],
  });
  const [vault] = await findAssociatedTokenPda({
    owner: distributor,
    mint: address(input.mint),
    tokenProgram: address(input.program),
  });
  return { distributor: distributor as string, vault: vault as string };
}
export async function airdropClaimStatus(
  distributor: string,
  claimant: string,
) {
  const [status] = await getProgramDerivedAddress({
    programAddress: address(AIRDROP_PROGRAM),
    seeds: [
      new TextEncoder().encode('ClaimStatus'),
      key(claimant),
      key(distributor),
    ],
  });
  return status as string;
}
async function eventAuthority() {
  const [authority] = await getProgramDerivedAddress({
    programAddress: address(AIRDROP_PROGRAM),
    seeds: [new TextEncoder().encode('__event_authority')],
  });
  return authority as string;
}

/** Cleans and validates the output wallets: distinct ordinary addresses, never the sender. */
export function airdropRecipients(value: unknown, sender: string) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > AIRDROP_MAX_RECIPIENTS
  )
    throw new Error(
      `Choose between 1 and ${AIRDROP_MAX_RECIPIENTS} output wallets.`,
    );
  const out = value.map((v) => walletAddress(v, 'Solana'));
  if (new Set(out).size !== out.length)
    throw new Error('Each output wallet can appear once.');
  if (out.includes(sender))
    throw new Error('The input wallet cannot also be an output wallet.');
  return out;
}

export function airdropCreateInput(body: {
  wallet: unknown;
  walletRevision: unknown;
  mint: unknown;
  percent: unknown;
  recipients: unknown;
  acknowledgeAirdrop: unknown;
}) {
  const wallet = walletAddress(body.wallet, 'Solana'),
    mint = walletAddress(body.mint, 'Solana');
  if ([SYSTEM, WSOL, wallet].includes(mint))
    throw new Error('Choose an ordinary SPL token mint.');
  if (
    !Number.isSafeInteger(body.walletRevision) ||
    Number(body.walletRevision) < 1
  )
    throw new Error('Choose the current wallet revision.');
  if (body.acknowledgeAirdrop !== true)
    throw new Error(
      'Acknowledge that the tokens leave this wallet until they are claimed or taken back.',
    );
  return {
    wallet,
    walletRevision: Number(body.walletRevision),
    mint,
    percentPpm: sendPercent(body.percent),
    recipients: airdropRecipients(body.recipients, wallet),
  };
}

/** Equal shares of a share of the wallet's balance; the remainder stays in the wallet. */
export function airdropShares(balanceRaw: bigint, ppm: bigint, count: number) {
  const perRecipient = (balanceRaw * ppm) / SEND_PERCENT_SCALE / BigInt(count);
  if (perRecipient < 1n)
    throw new Error('That share is below one token unit per output wallet.');
  return { perRecipient, total: perRecipient * BigInt(count) };
}
export function airdropSchedule(preparedAt: string) {
  const startTs =
    Math.floor(Date.parse(preparedAt) / 1000) + AIRDROP_START_DELAY_SECONDS;
  return {
    startTs,
    endTs: startTs + 1,
    clawbackTs: startTs + 1 + AIRDROP_CLAWBACK_DELAY_SECONDS,
  };
}

const w = (a: string) => ({ address: address(a), role: AccountRole.WRITABLE });
const r = (a: string) => ({ address: address(a), role: AccountRole.READONLY });
const data = (...parts: (number[] | Uint8Array)[]) =>
  Uint8Array.from(parts.flatMap((p) => [...p]));

export async function airdropInstructions(
  review: Pick<
    TokenAirdropReview,
    'kind' | 'wallet' | 'mint' | 'program' | 'decimals' | 'terms'
  >,
): Promise<{ tokenAccount: string; instructions: Instruction[] }> {
  const signer = createNoopSigner(address(review.wallet)),
    mint = address(review.mint),
    program = address(review.program),
    t = review.terms;
  if (![TOKEN_PROGRAM_ADDRESS, TOKEN_2022].includes(program))
    throw new Error('Unsupported token program.');
  const [tokenAccount] = await findAssociatedTokenPda({
    owner: signer.address,
    mint,
    tokenProgram: program,
  });
  const derived = await airdropAccounts({
    mint: review.mint,
    program: review.program,
    version: airdropUint(t.version),
  });
  if (derived.distributor !== t.distributor || derived.vault !== t.vault)
    throw new Error('Airdrop distributor accounts differ.');
  const per = airdropUint(t.perRecipientRaw);
  const programAddress = address(AIRDROP_PROGRAM) as Address;
  const signerMeta = {
    address: signer.address,
    role: AccountRole.WRITABLE_SIGNER,
  };
  if (review.kind === 'create') {
    const recipients = t.recipients;
    if (!recipients || review.wallet !== t.creator)
      throw new Error('Airdrop recipients required.');
    const total = per * BigInt(recipients.length);
    return {
      tokenAccount,
      instructions: [
        {
          programAddress,
          accounts: [
            w(t.distributor),
            w(tokenAccount), // clawback receiver: back to the creator
            r(review.mint),
            w(t.vault),
            signerMeta,
            r(SYSTEM),
            r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
            r(review.program),
            r(AIRDROP_FEE_CONFIG),
            r(AIRDROP_PARTNER_ORACLE),
          ],
          data: data(
            NEW_DISTRIBUTOR,
            u64le(airdropUint(t.version)),
            unhex(t.root),
            u64le(total), // max_total_claim
            u64le(BigInt(recipients.length)), // max_num_nodes
            u64le(1n), // unlock_period
            u64le(BigInt(t.startTs)),
            u64le(BigInt(t.endTs)),
            u64le(BigInt(t.clawbackTs)),
            [0], // claims_closable_by_admin = false
            [0, 0, 0, 0, 0], // five optional settings left unset
          ),
        },
        getTransferCheckedInstruction(
          {
            source: tokenAccount,
            mint,
            destination: address(t.vault),
            authority: signer,
            amount: total,
            decimals: review.decimals,
          },
          { programAddress: program },
        ) as Instruction,
      ],
    };
  }
  const ata = getCreateAssociatedTokenIdempotentInstruction({
    payer: signer,
    ata: tokenAccount,
    owner: signer.address,
    mint,
    tokenProgram: program,
  }) as Instruction;
  if (review.kind === 'claim') {
    if (!t.proof || t.recipients !== undefined)
      throw new Error('Airdrop proof required.');
    const proof = t.proof.map(unhex);
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, proof.length, true);
    return {
      tokenAccount,
      instructions: [
        ata,
        {
          programAddress,
          accounts: [
            w(t.distributor),
            w(await airdropClaimStatus(t.distributor, review.wallet)),
            w(t.vault),
            w(tokenAccount),
            signerMeta,
            r(review.mint),
            r(review.program),
            r(SYSTEM),
            r(await eventAuthority()),
            r(AIRDROP_PROGRAM),
          ],
          data: data(NEW_CLAIM, u64le(per), u64le(0n), count, ...proof),
        },
      ],
    };
  }
  if (review.kind !== 'clawback' || review.wallet !== t.creator)
    throw new Error('Only the creating wallet can take back an airdrop.');
  if (t.proof !== undefined || t.recipients !== undefined)
    throw new Error('A clawback carries no proof.');
  return {
    tokenAccount,
    instructions: [
      ata,
      {
        programAddress,
        accounts: [
          w(t.distributor),
          w(t.vault),
          w(tokenAccount),
          signerMeta,
          r(review.mint),
          r(SYSTEM),
          r(review.program),
        ],
        data: data(CLAWBACK),
      },
    ],
  };
}

export async function airdropMessage(
  review: Pick<
    TokenAirdropReview,
    | 'kind'
    | 'wallet'
    | 'mint'
    | 'program'
    | 'decimals'
    | 'terms'
    | 'blockhash'
    | 'lastValidBlockHeight'
  >,
) {
  const { tokenAccount, instructions } = await airdropInstructions(review);
  const compiled = compileTransactionMessage(
    pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayer(address(review.wallet), m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: parseBlockhash(review.blockhash),
            lastValidBlockHeight: airdropUint(review.lastValidBlockHeight),
          },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  if (
    compiled.header.numSignerAccounts !== 1 ||
    compiled.staticAccounts[0] !== review.wallet
  )
    throw new Error('Unexpected airdrop signers.');
  return {
    tokenAccount,
    message: Uint8Array.from(
      getCompiledTransactionMessageEncoder().encode(compiled),
    ),
  };
}
export const unsignedAirdropPacket = (message: Uint8Array) =>
  Uint8Array.from([1, ...new Uint8Array(64), ...message]);

/** Rebuilds the packet from the review terms and checks every byte, the hash, the merkle terms and (when signed) the wallet signature. */
export async function inspectAirdrop(
  review: TokenAirdropReview,
  transaction: string,
  signed: boolean,
) {
  const t = review?.terms;
  if (
    !review ||
    !t ||
    !UUID.test(review.id) ||
    !UUID.test(t.airdropId) ||
    review.network !== 'mainnet' ||
    !['create', 'claim', 'clawback'].includes(review.kind) ||
    (review.kind === 'create') !== (t.airdropId === review.id) ||
    !Number.isSafeInteger(review.walletRevision) ||
    review.walletRevision < 1 ||
    !Number.isSafeInteger(review.slot) ||
    review.slot < 0 ||
    !Number.isInteger(review.decimals) ||
    review.decimals < 0 ||
    review.decimals > 255 ||
    ![TOKEN_PROGRAM_ADDRESS, TOKEN_2022].includes(review.program) ||
    !Number.isFinite(Date.parse(review.preparedAt)) ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    Date.parse(review.expiresAt) <= Date.parse(review.preparedAt) ||
    Date.parse(review.expiresAt) - Date.parse(review.preparedAt) >
      LIFETIME_MS ||
    !/^[a-f0-9]{64}$/.test(review.sha256) ||
    ![t.startTs, t.endTs, t.clawbackTs].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    t.endTs !== t.startTs + 1 ||
    t.clawbackTs !== t.endTs + AIRDROP_CLAWBACK_DELAY_SECONDS
  )
    throw new Error('Airdrop review differs.');
  walletAddress(review.wallet, 'Solana');
  walletAddress(review.mint, 'Solana');
  walletAddress(t.creator, 'Solana');
  unhex(t.root);
  const per = airdropUint(t.perRecipientRaw),
    change = signedInt(review.tokenChangeRaw);
  if (per < 1n) throw new Error('Airdrop share differs.');
  airdropUint(review.feeLamports);
  airdropUint(review.solDebitLamports);
  airdropUint(review.reserveLamports);
  let amount: bigint;
  if (review.kind === 'create') {
    const recipients = airdropRecipients(t.recipients, review.wallet),
      schedule = airdropSchedule(review.preparedAt),
      ppm = airdropUint(review.percentPpm);
    amount = per * BigInt(recipients.length);
    if (
      t.proof !== undefined ||
      ppm < 1n ||
      ppm > SEND_PERCENT_SCALE ||
      schedule.startTs !== t.startTs ||
      change !== -amount ||
      (await airdropTree(recipients, per)).root !== t.root
    )
      throw new Error('Airdrop terms differ from their recipients.');
  } else if (review.kind === 'claim') {
    amount = per;
    if (
      review.percentPpm !== undefined ||
      !Array.isArray(t.proof) ||
      t.proof.length > 5 ||
      review.wallet === t.creator ||
      change !== per ||
      hex(
        await airdropProofRoot(
          await airdropLeaf(review.wallet, per),
          t.proof.map(unhex),
        ),
      ) !== t.root
    )
      throw new Error('Airdrop claim differs from its proof.');
  } else {
    amount = change;
    if (review.percentPpm !== undefined || change < 0n)
      throw new Error('Airdrop clawback differs.');
  }
  if (formatNativeBalance(amount.toString(), review.decimals) !== review.amount)
    throw new Error('Airdrop amount differs.');
  const { tokenAccount, message } = await airdropMessage(review);
  if (tokenAccount !== review.tokenAccount)
    throw new Error('Airdrop token account differs.');
  const bytes = airdropBytes(transaction),
    unsigned = unsignedAirdropPacket(message);
  if (
    bytes.length !== unsigned.length ||
    bytes[0] !== 1 ||
    bytes.slice(65).some((byte, i) => byte !== message[i]) ||
    (await airdropSha256(unsigned)) !== review.sha256 ||
    airdropBase64(unsigned) !== review.transaction
  )
    throw new Error('Airdrop packet differs from its exact review.');
  const signature = bytes.slice(1, 65);
  if (
    signed
      ? !verifySolanaSignature(message, signature, bs58.decode(review.wallet))
      : signature.some((byte) => byte !== 0)
  )
    throw new Error('Invalid airdrop wallet signature.');
  return {
    bytes,
    message,
    signature: signed ? bs58.encode(signature) : null,
  };
}

/** Browser-only: signs the exact reviewed packet with the vault key, then wipes the key bytes. */
export async function signAirdrop(
  session: VaultSession,
  review: TokenAirdropReview,
  assertCurrent: () => void,
) {
  const { message } = await inspectAirdrop(review, review.transaction, false);
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
      throw new Error('Airdrop approval expired or changed.');
    const signature = nacl.sign.detached(message, pair.secretKey);
    assertCurrent();
    return {
      signature: bs58.encode(signature),
      transaction: airdropBase64(
        Uint8Array.from([1, ...signature, ...message]),
      ),
    };
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
}

export async function validatedAirdropAction(
  value: unknown,
): Promise<TokenAirdropAction> {
  const row = value as TokenAirdropAction,
    review = row?.document;
  if (
    !row ||
    !review ||
    row.id !== review.id ||
    row.airdropId !== review.terms?.airdropId ||
    row.wallet !== review.wallet ||
    row.walletRevision !== review.walletRevision ||
    row.kind !== review.kind ||
    row.mint !== review.mint ||
    ![
      'awaiting_signature',
      'signing',
      'signed',
      'submitted',
      'finalized',
      'failed',
      'cancelled',
    ].includes(row.state) ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    !Number.isFinite(Date.parse(row.updatedAt))
  )
    throw new Error('Airdrop history differs.');
  await inspectAirdrop(review, review.transaction, false);
  if (
    ['awaiting_signature', 'signing', 'cancelled'].includes(row.state)
      ? row.signature !== null
      : typeof row.signature !== 'string' ||
        row.signature.length > 90 ||
        bs58.decode(row.signature).length !== 64
  )
    throw new Error('Airdrop signature history differs.');
  const receipt = row.receipt;
  if (row.state === 'finalized' || (row.state === 'failed' && receipt)) {
    if (
      !receipt ||
      receipt.network !== 'mainnet' ||
      receipt.commitment !== 'finalized' ||
      receipt.signature !== row.signature ||
      receipt.failed !== (row.state === 'failed') ||
      !Number.isSafeInteger(receipt.slot) ||
      receipt.slot < review.slot
    )
      throw new Error('Airdrop receipt differs.');
    if (
      airdropUint(receipt.networkFeeLamports) > airdropUint(review.feeLamports)
    )
      throw new Error('Airdrop receipt fee exceeds approval.');
    if (
      !receipt.failed &&
      !airdropSettled(review, signedInt(receipt.tokenChangeRaw))
    )
      throw new Error('Airdrop receipt units differ.');
  } else if (receipt !== null) throw new Error('Unexpected airdrop receipt.');
  return row;
}

/** A create or claim must move exactly the reviewed units; a clawback returns whatever was left, never less than nothing. */
export function airdropSettled(review: TokenAirdropReview, change: bigint) {
  return review.kind === 'clawback'
    ? change >= 0n
    : change === signedInt(review.tokenChangeRaw);
}
