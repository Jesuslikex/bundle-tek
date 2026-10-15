import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { solanaTransferMessage } from './solana-transfer-message';
import { verifySolanaSignature } from './solana-signature';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from './pump-holder-review';
import {
  requirePumpLaunchGroupReview,
  type PumpLaunchGroupReview,
} from './pump-launch-group-review';
import { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';
import type { VaultSession } from './browser-wallet-vault';
import type { PumpGroupRuntimePreview } from './pump-group-runtime-authorization';
export const PUMP_GROUP_JITO_ENDPOINT =
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
/** Reviewed mainnet profile from https://docs.jito.wtf/lowlatencytxnsend/#gettipaccounts, 15 October 2026. Destination changes require review, not an RPC-only replacement. */
export const PUMP_GROUP_JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
] as const;
export type PumpGroupBroadcastReview = {
  format: 'pump-group-jito-broadcast-v1';
  id: string;
  reviewId: string;
  contextSha256: string;
  signedGroupSha256: string;
  codeIdentitySha256: string;
  endpoint: typeof PUMP_GROUP_JITO_ENDPOINT;
  payer: string;
  recipient: string;
  tipRaw: string;
  tipFeeLimitRaw: string;
  tipTransaction: string;
  lastValidBlockHeight: string;
  blockhash: string;
  transactions: string[];
  createdAt: string;
  expiresAt: string;
  sha256: string;
  atomicity: 'jito-transport-requested-not-proven';
  executionAllowed: false;
  completeLaunch: false;
};
export type PumpGroupBroadcastConsent = {
  approved: true;
  reviewId: string;
  broadcastId: string;
  broadcastSha256: string;
  signedGroupSha256: string;
  scope: 'one-attempt-jito-complete-group-and-tip';
  acknowledgeUncertainOutcome: true;
};
export type PumpGroupBroadcastTip = {
  transaction: string;
  signature: string;
  sha256: string;
};
export type PumpGroupBroadcastState = {
  review: PumpGroupBroadcastReview;
  code: PumpGroupRuntimePreview;
  tip: PumpGroupBroadcastTip | null;
  attempted: boolean;
  result: { bundleId: string | null; outcome: 'accepted' | 'unknown' } | null;
  recovery: PumpGroupBroadcastRecovery | null;
  reservationsReleased: boolean;
};
export type PumpGroupBroadcastRecovery = {
  format: 'pump-group-jito-recovery-v1';
  id: string;
  reviewId: string;
  broadcastId: string;
  broadcastSha256: string;
  signedGroupSha256: string;
  observedAt: string;
  sha256: string;
  state:
    | 'finalized'
    | 'failed'
    | 'expired-unobserved'
    | 'partial'
    | 'pending'
    | 'unknown';
  groupObservationId: string;
  groupObservationSha256: string;
  tip: {
    signature: string | null;
    finalized: boolean;
    succeeded: boolean | null;
    slot: string | null;
    networkFeeRaw: string | null;
    tipDebitRaw: string | null;
  };
  bundle: { bundleId: string | null; finalized: boolean; slot: string | null };
  reservationsReleased: boolean;
  economicSettlementVerified: false;
  completeLaunch: false;
};
export type PumpGroupBroadcastTerminalReceipt = {
  format: 'pump-launch-group-broadcast-terminal-v1';
  kind: 'finalized' | 'failed' | 'expired-unobserved';
  reviewId: string;
  contextSha256: string;
  manifestSha256: string;
  signedGroupSha256: string;
  broadcastId: string;
  broadcastSha256: string;
  observationId: string;
  observationSha256: string;
  observedAt: string;
  sourceState: 'signed';
  knownNetworkFeeRaw: string;
  groupNetworkFeeRaw: string;
  tipNetworkFeeRaw: string | null;
  tipDebitRaw: string | null;
  networkFeeUnresolved: boolean;
  reservationsReleased: true;
  economicSettlementVerified: false;
  signingAllowed: false;
  executionAllowed: false;
  completeLaunch: false;
  atomicity: 'jito-transport-requested-not-proven';
};
export const broadcastInteger = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    throw new Error('Invalid broadcast raw amount.');
  return BigInt(v);
};
export function broadcastBudgets(tip: unknown, fee: unknown) {
  const t = broadcastInteger(tip),
    f = broadcastInteger(fee);
  if (t < 1000n || t > 10000000n || f < 1n || f > 100000n)
    throw new Error(
      'Review a Jito tip of 1,000 to 10,000,000 lamports and a fee cap up to 100,000 lamports.',
    );
  return { tip: t, fee: f };
}
/** Supporting status only. Finalized packet receipts remain authoritative. Jito uses ordinary JSON numeric slots. */
export function pumpGroupJitoStatus(
  value: unknown,
  bundleId: string,
  signatures: string[],
) {
  const empty = { bundleId, finalized: false, slot: null as string | null };
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (
    !record(value) ||
    !Array.isArray(value.value) ||
    value.value.length !== 1 ||
    !record(value.value[0])
  )
    return empty;
  const status = value.value[0],
    slot =
      typeof status.slot === 'number' &&
      Number.isSafeInteger(status.slot) &&
      status.slot > 0
        ? status.slot.toString()
        : typeof status.slot === 'string' &&
            /^[1-9]\d{0,15}$/.test(status.slot) &&
            BigInt(status.slot) <= BigInt(Number.MAX_SAFE_INTEGER)
          ? status.slot
          : null;
  if (
    status.bundle_id !== bundleId ||
    status.confirmation_status !== 'finalized' ||
    !(
      status.err === null ||
      (record(status.err) &&
        Object.keys(status.err).length === 1 &&
        status.err.Ok === null)
    ) ||
    !Array.isArray(status.transactions) ||
    status.transactions.some((v) => typeof v !== 'string') ||
    canonicalPumpHolderJson(status.transactions) !==
      canonicalPumpHolderJson(signatures) ||
    slot === null
  )
    return empty;
  return { bundleId, finalized: true, slot };
}
export function buildPumpGroupTip(
  review: Pick<
    PumpGroupBroadcastReview,
    'payer' | 'recipient' | 'blockhash' | 'tipRaw'
  >,
) {
  const message = solanaTransferMessage(
    review.payer,
    review.recipient,
    review.blockhash,
    broadcastInteger(review.tipRaw),
  );
  return {
    message,
    transaction: Buffer.from(
      Uint8Array.from([1, ...new Uint8Array(64), ...message]),
    ).toString('base64'),
  };
}
export async function requirePumpGroupBroadcastReview(
  value: PumpGroupBroadcastReview,
  group: PumpLaunchGroupReview,
  live = true,
) {
  await requirePumpLaunchGroupReview(group, live);
  const r = structuredClone(value);
  if (
    !r ||
    r.format !== 'pump-group-jito-broadcast-v1' ||
    !/^[a-f0-9-]{36}$/.test(r.id) ||
    r.reviewId !== group.id ||
    r.contextSha256 !== group.contextSha256 ||
    r.payer !== group.input.create.payer ||
    r.blockhash !== group.input.create.blockhash ||
    r.lastValidBlockHeight !== group.input.create.lastValidBlockHeight ||
    r.endpoint !== PUMP_GROUP_JITO_ENDPOINT ||
    !(PUMP_GROUP_JITO_TIP_ACCOUNTS as readonly string[]).includes(
      r.recipient,
    ) ||
    r.atomicity !== 'jito-transport-requested-not-proven' ||
    r.executionAllowed !== false ||
    r.completeLaunch !== false ||
    !/^[a-f0-9]{64}$/.test(r.codeIdentitySha256) ||
    r.expiresAt !== group.expiresAt ||
    !Number.isFinite(Date.parse(r.createdAt)) ||
    Date.parse(r.createdAt) > Date.now() + 1000 ||
    !Array.isArray(r.transactions) ||
    r.transactions.length !== group.packets.length ||
    r.transactions.length > 4
  )
    throw new Error('Complete group broadcast scope or lifetime differs.');
  broadcastBudgets(r.tipRaw, r.tipFeeLimitRaw);
  if (buildPumpGroupTip(r).transaction !== r.tipTransaction)
    throw new Error('Reviewed tip bytes differ.');
  const signed = await verifyPumpLaunchGroupSignatures(group, r.transactions);
  if (signed.signedGroupSha256 !== r.signedGroupSha256)
    throw new Error('Broadcast signed group differs.');
  const { sha256, ...body } = r;
  if (sha256 !== (await pumpHolderDigest(body)))
    throw new Error('Broadcast digest differs.');
  if (live && Date.parse(r.expiresAt) <= Date.now())
    throw new Error('Broadcast review expired.');
  return r;
}
export function requirePumpGroupBroadcastConsent(
  r: PumpGroupBroadcastReview,
  c: unknown,
): asserts c is PumpGroupBroadcastConsent {
  if (
    !c ||
    typeof c !== 'object' ||
    canonicalPumpHolderJson(c) !==
      canonicalPumpHolderJson({
        approved: true,
        reviewId: r.reviewId,
        broadcastId: r.id,
        broadcastSha256: r.sha256,
        signedGroupSha256: r.signedGroupSha256,
        scope: 'one-attempt-jito-complete-group-and-tip',
        acknowledgeUncertainOutcome: true,
      })
  )
    throw new Error(
      'Explicit one-attempt approval of the entire group and tip is required.',
    );
}
export async function verifyPumpGroupTip(
  r: PumpGroupBroadcastReview,
  transaction: string,
): Promise<PumpGroupBroadcastTip> {
  const bytes = Uint8Array.from(Buffer.from(transaction, 'base64'));
  const { message } = buildPumpGroupTip(r);
  if (
    transaction.length > 600 ||
    Buffer.from(bytes).toString('base64') !== transaction ||
    bytes.length !== message.length + 65 ||
    bytes[0] !== 1 ||
    !message.every((v, i) => bytes[i + 65] === v)
  )
    throw new Error('Signed tip message differs.');
  const signature = bs58.encode(bytes.slice(1, 65));
  if (!verifySolanaSignature(message, bytes.slice(1, 65), bs58.decode(r.payer)))
    throw new Error('Tip signature differs.');
  return {
    transaction,
    signature,
    sha256: await pumpHolderDigest({ transaction }),
  };
}
export async function signPumpGroupTip(
  session: VaultSession,
  r: PumpGroupBroadcastReview,
  group: PumpLaunchGroupReview,
  current: () => void,
  signal: AbortSignal,
) {
  const guard = () => {
    signal.throwIfAborted();
    current();
    if (Date.parse(r.expiresAt) <= Date.now())
      throw new Error('Tip approval expired.');
  };
  guard();
  await requirePumpGroupBroadcastReview(r, group);
  guard();
  const wallet = session.payload.wallets.find(
    (w) => w.family === 'solana' && w.address === r.payer,
  );
  if (!wallet || !/^[a-f0-9]{64}$/.test(wallet.seed))
    throw new Error('Exact group payer is missing from the browser vault.');
  const seed = Uint8Array.from(wallet.seed.match(/../g)!, (v) =>
    parseInt(v, 16),
  );
  const pair = nacl.sign.keyPair.fromSeed(seed);
  try {
    if (bs58.encode(pair.publicKey) !== r.payer)
      throw new Error('Tip payer key differs.');
    guard();
    const { message } = buildPumpGroupTip(r);
    const transaction = Buffer.from(
      Uint8Array.from([
        1,
        ...nacl.sign.detached(message, pair.secretKey),
        ...message,
      ]),
    ).toString('base64');
    guard();
    const signed = await verifyPumpGroupTip(r, transaction);
    guard();
    return signed;
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
}
