import bs58 from 'bs58';
import { address } from '@solana/kit';
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { balanceRpc } from './wallet-balances';
import { getSolanaRpcEndpoint } from './solana-rpc';
import { DEVNET_GENESIS_HASH } from './devnet-intent';
import { toBaseUnits } from './distribution-plan';
import type { WalletOperationDocument } from './wallet-operation';
import {
  distributionAuditKey,
  type DistributionClaim,
} from './distribution-audit';

export class ReceiptError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
type Row = Record<string, unknown>;
const object = (v: unknown): Row => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new ReceiptError('Incomplete transaction evidence.');
  return v as Row;
};
const integer = (v: unknown) => {
  if (
    (typeof v !== 'number' &&
      (typeof v !== 'string' || !/^\d{1,16}$/.test(v))) ||
    !Number.isSafeInteger(Number(v)) ||
    Number(v) < 0
  )
    throw new ReceiptError('Invalid transaction number.');
  return Number(v);
};
const rawAmount = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    throw new ReceiptError('Invalid token balance evidence.');
  return BigInt(v);
};
const nativeAmount = (v: unknown) => {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0)
      throw new ReceiptError('Invalid native balance evidence.');
    return rawAmount(String(v));
  }
  return rawAmount(v);
};
export function assertTransactionSignature(v: unknown): string {
  if (typeof v !== 'string' || v.length > 90 || bs58.decode(v).length !== 64)
    throw new ReceiptError('Invalid transaction signature.');
  return v;
}
export async function readFinalizedDevnetTransaction(
  signature: string,
  fetcher = fetch,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const endpoint = getSolanaRpcEndpoint('devnet');
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(endpoint, method, params, controller.signal, fetcher);
  const pending = (async () => {
    if ((await rpc('getGenesisHash', [])) !== DEVNET_GENESIS_HASH)
      throw new ReceiptError('Receipt RPC is not Solana devnet.', 502);
    const tx = await rpc('getTransaction', [
      signature,
      {
        commitment: 'finalized',
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (!tx)
      throw new ReceiptError(
        'Transaction is not finalized yet or is unavailable. Retry receipt verification.',
        404,
      );
    return tx;
  })();
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new ReceiptError(
              'Receipt provider timed out. Retry verification.',
              502,
            ),
          );
        }, 25_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
export async function readDevnetOperationSlot(fetcher = fetch) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(
      getSolanaRpcEndpoint('devnet'),
      method,
      params,
      controller.signal,
      fetcher,
    );
  const pending = (async () => {
    if ((await rpc('getGenesisHash', [])) !== DEVNET_GENESIS_HASH)
      throw new ReceiptError('Preparation RPC is not Solana devnet.', 502);
    return integer(await rpc('getSlot', [{ commitment: 'confirmed' }]));
  })();
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ReceiptError('Devnet preparation timed out.', 502));
        }, 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
function evidence(
  value: unknown,
  signature: string,
  wallet: string,
  failed = false,
) {
  const tx = object(value),
    meta = object(tx.meta),
    transaction = object(tx.transaction),
    message = object(transaction.message);
  if (!failed && meta.err !== null)
    throw new ReceiptError('Transaction did not succeed.');
  if (
    !Array.isArray(transaction.signatures) ||
    transaction.signatures[0] !== signature
  )
    throw new ReceiptError('Transaction signature does not match.');
  if (
    !Array.isArray(message.accountKeys) ||
    !message.accountKeys.length ||
    message.accountKeys.length > 256 ||
    !Array.isArray(message.instructions) ||
    !message.instructions.length ||
    message.instructions.length > 8
  )
    throw new ReceiptError('Incomplete transaction message.');
  const keys = message.accountKeys.map(object);
  if (
    keys[0].pubkey !== wallet ||
    keys[0].signer !== true ||
    new Set(keys.map((key) => key.pubkey)).size !== keys.length
  )
    throw new ReceiptError(
      'Transaction was not signed by the reviewed wallet.',
    );
  const slot = integer(tx.slot),
    blockTime = integer(tx.blockTime);
  if (blockTime === 0 || blockTime * 1000 > Date.now() + 60_000)
    throw new ReceiptError('Invalid transaction time.');
  let failure: { transactionError: string; feeLamports: string } | undefined;
  if (failed) {
    const err = meta.err;
    let normalizedError = err;
    const variant = (v: unknown) =>
      typeof v === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(v);
    let validError = variant(err);
    if (err && typeof err === 'object' && !Array.isArray(err)) {
      const entries = Object.entries(err);
      if (entries.length === 1 && entries[0][0] === 'InstructionError') {
        const pair = entries[0][1];
        if (
          Array.isArray(pair) &&
          pair.length === 2 &&
          integer(pair[0]) < message.instructions.length
        ) {
          let detail = pair[1];
          validError = variant(detail);
          if (
            !validError &&
            detail &&
            typeof pair[1] === 'object' &&
            !Array.isArray(pair[1]) &&
            Object.keys(pair[1]).length === 1 &&
            Object.hasOwn(pair[1], 'Custom')
          ) {
            const custom = integer(pair[1].Custom);
            validError = custom <= 0xffffffff;
            detail = { Custom: custom };
          }
          normalizedError = { InstructionError: [integer(pair[0]), detail] };
        }
      }
    }
    if (!validError)
      throw new ReceiptError(
        'Finalized failure evidence is missing or unsupported.',
      );
    const fee = nativeAmount(meta.fee);
    if (
      !Array.isArray(meta.preBalances) ||
      !Array.isArray(meta.postBalances) ||
      meta.preBalances.length !== keys.length ||
      meta.postBalances.length !== keys.length
    )
      throw new ReceiptError('Failure balance evidence is incomplete.');
    for (let index = 0; index < keys.length; index++) {
      const before = nativeAmount(meta.preBalances[index]),
        after = nativeAmount(meta.postBalances[index]);
      if (before - after !== (index === 0 ? fee : 0n))
        throw new ReceiptError(
          'Failed transaction changed balances beyond its fee.',
        );
    }
    failure = {
      transactionError: JSON.stringify(normalizedError),
      feeLamports: String(fee),
    };
  }
  return {
    tx,
    meta,
    keys,
    instructions: message.instructions.map(object),
    slot,
    blockTime,
    failure,
  };
}
export function verifyMemoReceipt(
  value: unknown,
  signature: string,
  wallet: string,
  failed = false,
) {
  const data = evidence(value, signature, wallet, failed);
  const memos = data.instructions.filter(
    (instruction) => instruction.programId === MEMO,
  );
  if (
    memos.length !== 1 ||
    typeof memos[0].parsed !== 'string' ||
    !memos[0].parsed.startsWith('PulseForge verified devnet wallet ') ||
    data.instructions.some(
      (instruction) =>
        instruction.programId !== MEMO && instruction.programId !== COMPUTE,
    )
  )
    throw new ReceiptError('Transaction is not the reviewed PulseForge memo.');
  return {
    slot: data.slot,
    blockTime: data.blockTime,
    commitment: 'finalized',
    ...data.failure,
  };
}
export function verifyNativeFundingReceipt(
  value: unknown,
  signature: string,
  intent: Extract<WalletOperationDocument, { kind: 'sol' }>,
  failed = false,
) {
  const data = evidence(value, signature, intent.wallet, failed),
    system = '11111111111111111111111111111111',
    transfers = data.instructions.filter((ix) => ix.programId === system);
  if (
    transfers.length !== 1 ||
    data.instructions.some(
      (ix) => ix.programId !== system && ix.programId !== COMPUTE,
    ) ||
    data.keys.filter((key) => key.signer === true).length !== 1 ||
    data.keys[0].writable !== true ||
    !Array.isArray(data.meta.innerInstructions) ||
    data.meta.innerInstructions.length ||
    !Array.isArray(data.meta.preTokenBalances) ||
    data.meta.preTokenBalances.length ||
    !Array.isArray(data.meta.postTokenBalances) ||
    data.meta.postTokenBalances.length
  )
    throw new ReceiptError(
      'Expected one native SOL funding transfer without additional effects.',
    );
  const parsed = object(transfers[0].parsed),
    info = object(parsed.info),
    raw = toBaseUnits(intent.amount, 9),
    recipientIndex = data.keys.findIndex(
      (key) => key.pubkey === intent.recipient,
    );
  if (
    parsed.type !== 'transfer' ||
    info.source !== intent.wallet ||
    info.destination !== intent.recipient ||
    nativeAmount(info.lamports) !== raw ||
    recipientIndex <= 0 ||
    data.keys[recipientIndex].writable !== true
  )
    throw new ReceiptError(
      'Native SOL instruction differs from the saved funding intent.',
    );
  const fee = nativeAmount(data.meta.fee);
  if (
    !Array.isArray(data.meta.preBalances) ||
    !Array.isArray(data.meta.postBalances) ||
    data.meta.preBalances.length !== data.keys.length ||
    data.meta.postBalances.length !== data.keys.length
  )
    throw new ReceiptError('Native SOL balance evidence is incomplete.');
  if (!failed)
    for (let index = 0; index < data.keys.length; index++) {
      const delta =
        nativeAmount(data.meta.postBalances[index]) -
        nativeAmount(data.meta.preBalances[index]);
      if (
        delta !==
        (index === 0 ? -raw - fee : index === recipientIndex ? raw : 0n)
      )
        throw new ReceiptError(
          'Native SOL balance changes do not match funding and fees.',
        );
    }
  return {
    slot: data.slot,
    blockTime: data.blockTime,
    commitment: 'finalized',
    fundingId: intent.fundingId,
    fundingRevision: intent.fundingRevision,
    fundingKey: intent.fundingKey,
    recipient: intent.recipient,
    amount: intent.amount,
    rawAmount: raw.toString(),
    feeLamports: fee.toString(),
    ...data.failure,
  };
}
export async function verifyTokenReceipt(
  value: unknown,
  signature: string,
  claim: DistributionClaim,
  recipient: string,
  failed = false,
) {
  const expected = claim.recipients.find((row) => row.address === recipient);
  if (!expected)
    throw new ReceiptError('Recipient is not in this distribution.');
  const data = evidence(value, signature, claim.wallet, failed);
  const transfers = data.instructions.filter(
    (instruction) => instruction.programId === TOKEN_PROGRAM_ADDRESS,
  );
  if (transfers.length !== 1)
    throw new ReceiptError('Expected exactly one standard SPL transfer.');
  const parsed = object(transfers[0].parsed),
    info = object(parsed.info),
    tokenAmount = object(info.tokenAmount);
  const decimals = integer(tokenAmount.decimals),
    raw = toBaseUnits(expected.amount, decimals);
  const [sourceAta] = await findAssociatedTokenPda({
    owner: address(claim.wallet),
    mint: address(claim.mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [destinationAta] = await findAssociatedTokenPda({
    owner: address(recipient),
    mint: address(claim.mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  if (
    parsed.type !== 'transferChecked' ||
    info.authority !== claim.wallet ||
    info.mint !== claim.mint ||
    info.source !== sourceAta ||
    info.destination !== destinationAta ||
    rawAmount(tokenAmount.amount) !== raw
  )
    throw new ReceiptError(
      'Transfer does not match the reviewed wallet, mint, recipient and amount.',
    );
  for (const instruction of data.instructions) {
    if (
      instruction.programId === TOKEN_PROGRAM_ADDRESS ||
      instruction.programId === COMPUTE
    )
      continue;
    if (instruction.programId !== ATA)
      throw new ReceiptError(
        'Transaction contains an unsupported additional instruction.',
      );
    const creation = object(instruction.parsed),
      details = object(creation.info);
    if (
      creation.type !== 'createIdempotent' ||
      details.account !== destinationAta ||
      details.mint !== claim.mint ||
      details.wallet !== recipient ||
      details.source !== claim.wallet ||
      details.tokenProgram !== TOKEN_PROGRAM_ADDRESS
    )
      throw new ReceiptError(
        'Associated account creation does not match the reviewed transfer.',
      );
  }
  function balance(
    rows: unknown,
    account: string,
    owner: string,
    optional = false,
  ) {
    if (!Array.isArray(rows))
      throw new ReceiptError('Token balance history is missing.');
    const index = data.keys.findIndex((key) => key.pubkey === account);
    if (index < 0)
      throw new ReceiptError('Token account is missing from the transaction.');
    const matches = rows
      .map(object)
      .filter((row) => integer(row.accountIndex) === index);
    if (!matches.length && optional) return 0n;
    if (matches.length !== 1)
      throw new ReceiptError(
        'Token balance evidence is incomplete or duplicated.',
      );
    const row = matches[0],
      amount = object(row.uiTokenAmount);
    if (
      row.mint !== claim.mint ||
      row.owner !== owner ||
      (row.programId !== undefined &&
        row.programId !== TOKEN_PROGRAM_ADDRESS) ||
      integer(amount.decimals) !== decimals
    )
      throw new ReceiptError('Token balance ownership does not match.');
    return rawAmount(amount.amount);
  }
  const sent =
    balance(data.meta.preTokenBalances, sourceAta, claim.wallet, failed) -
    balance(data.meta.postTokenBalances, sourceAta, claim.wallet, failed);
  const received =
    balance(data.meta.postTokenBalances, destinationAta, recipient, failed) -
    balance(data.meta.preTokenBalances, destinationAta, recipient, true);
  if (sent !== (failed ? 0n : raw) || received !== (failed ? 0n : raw))
    throw new ReceiptError(
      'Effective token balance changes do not match the transfer.',
    );
  return {
    distributionKey: await distributionAuditKey(claim),
    mint: claim.mint,
    recipient,
    amount: expected.amount,
    rawAmount: raw.toString(),
    decimals,
    sourceAta,
    destinationAta,
    slot: data.slot,
    blockTime: data.blockTime,
    commitment: 'finalized',
    ...data.failure,
  };
}
