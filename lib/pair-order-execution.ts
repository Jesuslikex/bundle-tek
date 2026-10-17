import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { getSolanaStockRuntimeRpcEndpoint } from './solana-rpc';
import { solanaTokenBalanceChanges } from './solana-token-balance-changes';
import { ImportedPairQuoteError } from './imported-pair-quote-service';
import { pairStockSigningPolicy } from './pair-stock-signing-policy';
import { verifyPairOrderSignedPacket } from './pair-order-signing';

export type PairOrderExecutionRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
export type PairOrderSendConsent = {
  authorizationId: string;
  packetSha256: string;
  signature: string;
  sendExactSignedPacketOnce: true;
};
type Row = {
  authorization_id: string;
  review_id: string;
  owner_id: string;
  wallet: string;
  packet: string;
  packet_sha256: string;
  input_mint: string;
  output_mint: string;
  minimum_output_raw: string;
  last_valid_block_height: string;
  authorization_expires_at: string;
  review_expires_at: string;
  state:
    | 'reserved'
    | 'signed'
    | 'submitting'
    | 'submitted'
    | 'finalized'
    | 'failed'
    | 'expired';
  signed_packet: string | null;
  signature: string | null;
  signed_at: string | null;
  send_consent: string | null;
  submitting_at: string | null;
  receipt: string | null;
  created_at: string;
  updated_at: string;
};
const WRAPPED = 'So11111111111111111111111111111111111111112';
const ACTIVE = ['reserved', 'signed', 'submitting', 'submitted'];
const fail = (message: string, status = 409): never => {
  throw new ImportedPairQuoteError(message, status);
};
const iso = () => new Date().toISOString();

export function pairOrderExecutionRpc(): PairOrderExecutionRpc {
  const endpoint = getSolanaStockRuntimeRpcEndpoint(),
    url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('Invalid stock execution provider.');
  return (method, params, signal) =>
    balanceRpc(endpoint, method, params, signal, fetch, 2097152);
}

/** Public view: no unsigned packet substitution, signing or sending authority implied. */
export function publicPairOrderExecution(row: Row) {
  return {
    authorizationId: row.authorization_id,
    reviewId: row.review_id,
    wallet: row.wallet,
    packet: row.packet,
    packetSha256: row.packet_sha256,
    minimumOutputRaw: row.minimum_output_raw,
    outputMint: row.output_mint,
    state: row.state,
    // Submitting without an observed provider reply is reported as unknown, never resent.
    outcome:
      row.state === 'submitting'
        ? ('unknown' as const)
        : row.state === 'expired' && row.send_consent
          ? ('expired-unobserved' as const)
          : row.state,
    signature: row.signature,
    receipt: row.receipt ? JSON.parse(row.receipt) : null,
    reservationHeld: ACTIVE.includes(row.state),
  };
}

export async function readOwnedPairOrderExecution(
  db: D1Database,
  owner: string,
  authorizationId: string,
) {
  if (
    typeof authorizationId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(authorizationId)
  )
    fail('Invalid authorization id.', 400);
  const row = await db
    .prepare(
      'SELECT * FROM pair_order_executions WHERE authorization_id=? AND owner_id=?',
    )
    .bind(authorizationId, owner)
    .first<Row>();
  if (!row) return fail('Stock order execution not found.', 404);
  return row;
}

const packetOf = (row: Row) => ({
  authorizationId: row.authorization_id,
  wallet: row.wallet,
  packet: row.packet,
  packetSha256: row.packet_sha256,
});

async function transition(
  db: D1Database,
  row: Row,
  next: Row['state'],
  fields: Partial<
    Pick<
      Row,
      | 'signed_packet'
      | 'signature'
      | 'signed_at'
      | 'send_consent'
      | 'submitting_at'
      | 'receipt'
    >
  >,
) {
  const merged = { ...row, ...fields, state: next, updated_at: iso() };
  const saved = await db
    .prepare(
      'UPDATE pair_order_executions SET state=?,signed_packet=?,signature=?,signed_at=?,send_consent=?,submitting_at=?,receipt=?,updated_at=? WHERE authorization_id=? AND owner_id=? AND state=?',
    )
    .bind(
      merged.state,
      merged.signed_packet,
      merged.signature,
      merged.signed_at,
      merged.send_consent,
      merged.submitting_at,
      merged.receipt,
      merged.updated_at,
      row.authorization_id,
      row.owner_id,
      row.state,
    )
    .run();
  if (saved.meta.changes !== 1)
    fail('Stock order execution changed concurrently. Reload its state.');
  return merged as Row;
}

/** Immutable signed registration; the exact approved packet and one strict signature only. */
export async function registerPairOrderSignature(
  db: D1Database,
  owner: string,
  authorizationId: string,
  signedPacket: unknown,
) {
  const policy = pairStockSigningPolicy();
  if (!policy.qualified) fail(policy.reason);
  const row = await readOwnedPairOrderExecution(db, owner, authorizationId);
  if (row.state !== 'reserved') {
    if (row.signed_packet && row.signed_packet === signedPacket)
      return publicPairOrderExecution(row);
    fail('This stock order already has an immutable signature.');
  }
  let signature: string;
  try {
    signature = await verifyPairOrderSignedPacket(packetOf(row), signedPacket);
  } catch {
    return fail('Signed stock packet differs from the approved packet.', 400);
  }
  const now = Date.now();
  if (
    now > Date.parse(row.authorization_expires_at) + 15000 ||
    now >= Date.parse(row.review_expires_at)
  )
    fail('Signing authorization expired. Request a new review.');
  return publicPairOrderExecution(
    await transition(db, row, 'signed', {
      signed_packet: signedPacket as string,
      signature,
      signed_at: iso(),
    }),
  );
}

function requireSendConsent(row: Row, consent: unknown) {
  const c = consent as PairOrderSendConsent;
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    Object.keys(c).sort().join(',') !==
      'authorizationId,packetSha256,sendExactSignedPacketOnce,signature' ||
    c.sendExactSignedPacketOnce !== true ||
    c.authorizationId !== row.authorization_id ||
    c.packetSha256 !== row.packet_sha256 ||
    c.signature !== row.signature
  )
    fail(
      'Separately approve sending this exact signed stock packet once.',
      400,
    );
  return c;
}

const uint = (value: unknown) => {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(text))
    throw new Error('Invalid provider integer.');
  return BigInt(text);
};

/** One attempt. State is persisted before the only send call; a lost reply stays unknown and is never resent. */
export async function submitPairOrderExecution(
  db: D1Database,
  owner: string,
  authorizationId: string,
  consent: unknown,
  signal: AbortSignal,
  rpc: PairOrderExecutionRpc = pairOrderExecutionRpc(),
) {
  const policy = pairStockSigningPolicy();
  if (!policy.qualified) fail(policy.reason);
  let row = await readOwnedPairOrderExecution(db, owner, authorizationId);
  if (['submitting', 'submitted', 'finalized', 'failed'].includes(row.state))
    return publicPairOrderExecution(row);
  if (row.state !== 'signed' || !row.signed_packet || !row.signature)
    return fail('Register the exact signature before sending.');
  const accepted = requireSendConsent(row, consent);
  if (Date.now() >= Date.parse(row.review_expires_at))
    fail('Signed stock packet expired. Recover its outcome instead.');
  if (
    (await verifyPairOrderSignedPacket(packetOf(row), row.signed_packet)) !==
    row.signature
  )
    fail('Saved stock signature differs.');
  const [genesis, rawHeight] = await Promise.all([
    rpc('getGenesisHash', [], signal),
    rpc('getBlockHeight', [{ commitment: 'confirmed' }], signal),
  ]);
  signal.throwIfAborted();
  let height: bigint;
  try {
    height = uint(rawHeight);
  } catch {
    return fail('Stock packet lifetime unavailable. Nothing was sent.');
  }
  if (
    genesis !== SOLANA_MAINNET_GENESIS ||
    height + 10n > BigInt(row.last_valid_block_height)
  )
    fail('Stock packet lifetime or network changed. Nothing was sent.');
  row = await transition(db, row, 'submitting', {
    send_consent: JSON.stringify(accepted),
    submitting_at: iso(),
  });
  try {
    signal.throwIfAborted();
    const sent = await rpc(
      'sendTransaction',
      [
        row.signed_packet,
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 0,
        },
      ],
      signal,
    );
    if (sent !== row.signature) throw new Error('Different provider signature');
    row = await transition(db, row, 'submitted', {});
  } catch {
    // Unknown: the packet may or may not have landed. Only recovery may resolve it.
    return publicPairOrderExecution(
      await readOwnedPairOrderExecution(db, owner, authorizationId),
    );
  }
  return publicPairOrderExecution(row);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Incomplete stock receipt.');
  return value as Record<string, unknown>;
}

/** Verify a finalized receipt is the exact signed packet and measure the wallet's output. */
export function decodePairOrderReceipt(raw: unknown, row: Row) {
  const result = object(raw),
    meta = object(result.meta);
  if (
    !Array.isArray(result.transaction) ||
    result.transaction.length !== 2 ||
    result.transaction[0] !== row.signed_packet ||
    result.transaction[1] !== 'base64'
  )
    throw new Error('Finalized receipt packet differs from the signed packet.');
  const tx = getTransactionDecoder().decode(
    getBase64Encoder().encode(row.signed_packet!),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  const loaded = meta.loadedAddresses
    ? object(meta.loadedAddresses)
    : { writable: [], readonly: [] };
  if (!Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly))
    throw new Error('Incomplete stock receipt accounts.');
  const keys = [
    ...message.staticAccounts.map(String),
    ...(loaded.writable as string[]),
    ...(loaded.readonly as string[]),
  ];
  if (keys[0] !== row.wallet) throw new Error('Receipt fee payer differs.');
  const slot = uint(result.slot).toString(),
    fee = uint(meta.fee);
  if (meta.err !== null)
    return {
      format: 'pair-order-receipt-v1' as const,
      kind: 'failed' as const,
      signature: row.signature,
      slot,
      feeRaw: fee.toString(),
      error: JSON.stringify(meta.err).slice(0, 2000),
      minimumOutputRaw: row.minimum_output_raw,
      outputRaw: null,
      minimumOutputMet: false,
    };
  const tokens = solanaTokenBalanceChanges(
    keys,
    row.wallet,
    meta.preTokenBalances,
    meta.postTokenBalances,
  );
  if (!tokens.complete) throw new Error('Incomplete receipt token balances.');
  const tokenChange = tokens.changes
    .filter((c) => c.mint === row.output_mint)
    .reduce((sum, c) => sum + BigInt(c.changeRaw), 0n);
  let output = tokenChange,
    measurement = 'wallet-token-balance-change';
  if (row.output_mint === WRAPPED) {
    if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances))
      throw new Error('Incomplete receipt lamport balances.');
    if (meta.preBalances.length !== meta.postBalances.length)
      throw new Error('Incomplete receipt lamport balances.');
    // Lamports of any pre-existing account closed by this packet may have been
    // refunded to the wallet as rent, which is not swap output. Subtract them
    // all: this can only understate output, never overstate it. Accounts
    // created and closed inside the packet (temporary WSOL) start at zero.
    let closed = 0n;
    for (let i = 1; i < meta.preBalances.length; i++) {
      const before = uint(meta.preBalances[i]);
      if (before > 0n && uint(meta.postBalances[i]) === 0n) closed += before;
    }
    // Native output: lamport delta plus the fee the wallet paid, plus any WSOL
    // change, minus closed-account rent.
    output =
      uint(meta.postBalances[0]) -
      uint(meta.preBalances[0]) +
      fee +
      tokenChange -
      closed;
    measurement = 'native-lamport-delta-plus-fee-and-wsol-change-minus-closed';
  }
  return {
    format: 'pair-order-receipt-v1' as const,
    kind: 'finalized' as const,
    signature: row.signature,
    slot,
    feeRaw: fee.toString(),
    error: null,
    measurement,
    minimumOutputRaw: row.minimum_output_raw,
    outputRaw: output.toString(),
    minimumOutputMet: output >= BigInt(row.minimum_output_raw),
  };
}

/** Read-only finalized recovery. Never sends. Only terminal finalized evidence releases the reservation. */
export async function recoverPairOrderExecution(
  db: D1Database,
  owner: string,
  authorizationId: string,
  signal: AbortSignal,
  rpc: PairOrderExecutionRpc = pairOrderExecutionRpc(),
) {
  const row = await readOwnedPairOrderExecution(db, owner, authorizationId);
  if (!ACTIVE.includes(row.state)) return publicPairOrderExecution(row);
  if (row.state === 'reserved') {
    if (Date.now() <= Date.parse(row.authorization_expires_at) + 15000)
      return publicPairOrderExecution(row);
    return publicPairOrderExecution(
      await transition(db, row, 'expired', {
        receipt: JSON.stringify({
          format: 'pair-order-receipt-v1',
          kind: 'unsigned-authorization-expired',
          signature: null,
          observedAt: iso(),
        }),
      }),
    );
  }
  const [genesis, statuses] = await Promise.all([
    rpc('getGenesisHash', [], signal),
    rpc(
      'getSignatureStatuses',
      [[row.signature], { searchTransactionHistory: true }],
      signal,
    ),
  ]);
  signal.throwIfAborted();
  if (genesis !== SOLANA_MAINNET_GENESIS)
    return fail('Stock receipt network differs.');
  const status = (object(statuses).value as unknown[] | undefined)?.[0] as
    | { confirmationStatus?: unknown }
    | null
    | undefined;
  if (status && status.confirmationStatus === 'finalized') {
    const raw = await rpc(
      'getTransaction',
      [
        row.signature,
        {
          commitment: 'finalized',
          encoding: 'base64',
          maxSupportedTransactionVersion: 0,
        },
      ],
      signal,
    );
    signal.throwIfAborted();
    if (raw == null) return publicPairOrderExecution(row);
    let receipt: ReturnType<typeof decodePairOrderReceipt>;
    try {
      receipt = decodePairOrderReceipt(raw, row);
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : 'Stock receipt differs.',
      );
    }
    return publicPairOrderExecution(
      await transition(db, row, receipt.kind, {
        receipt: JSON.stringify({ ...receipt, observedAt: iso() }),
      }),
    );
  }
  if (status) return publicPairOrderExecution(row);
  // Not observed: only a finalized height beyond the packet lifetime proves it can no longer land.
  const height = uint(
    await rpc('getBlockHeight', [{ commitment: 'finalized' }], signal),
  );
  signal.throwIfAborted();
  if (height <= BigInt(row.last_valid_block_height))
    return publicPairOrderExecution(row);
  const confirm = await rpc(
    'getSignatureStatuses',
    [[row.signature], { searchTransactionHistory: true }],
    signal,
  );
  if ((object(confirm).value as unknown[] | undefined)?.[0])
    return publicPairOrderExecution(row);
  return publicPairOrderExecution(
    await transition(db, row, 'expired', {
      receipt: JSON.stringify({
        format: 'pair-order-receipt-v1',
        kind: 'expired-unobserved',
        signature: row.signature,
        finalizedBlockHeight: height.toString(),
        lastValidBlockHeight: row.last_valid_block_height,
        observedAt: iso(),
        feeRaw: null,
      }),
    }),
  );
}

/** Used by approval before inserting the reservation; the SQL trigger rechecks atomically. */
export async function pairOrderReservationAvailable(
  db: D1Database,
  owner: string,
  wallet: string,
) {
  const row = await db
    .prepare(
      `SELECT (SELECT count(*) FROM solana_execution_reservations WHERE owner_id=?1 AND wallet_address=?2)
 + (SELECT count(*) FROM pair_order_executions WHERE owner_id=?1 AND wallet=?2 AND state IN ('reserved','signed','submitting','submitted'))
 + (SELECT count(*) FROM pump_launch_reviews r WHERE r.owner_id=?1 AND r.state NOT IN ('cancelled','failed','finalized') AND (r.payer=?2
 OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') h WHERE json_extract(h.value,'$.kind')!='none' AND json_extract(h.value,'$.address')=?2))) AS n`,
    )
    .bind(owner, wallet)
    .first<{ n: number }>();
  return row?.n === 0;
}
