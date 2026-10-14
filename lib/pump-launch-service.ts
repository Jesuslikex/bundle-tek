import {
  readPumpHistoryPage,
  type PumpHistoryPage,
} from './pump-launch-history-page';
import {
  preflightOwnedPumpCreate,
  type OwnedPumpTerms,
  PumpPreflightError,
} from './owned-pump-preflight';
import {
  encodePumpSigningInput,
  requirePumpSigningReview,
  verifyPumpSignedPacket,
  type PumpSigningReview,
} from './pump-launch-signing';
import type { PumpCreateInput } from './pump-launch-message';
import { pumpCreateAddresses } from './pump-launch-message';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { validateProjectDocument } from './workspace-project';

type Row = {
  id: string;
  owner_id: string;
  project_id: string;
  payer: string;
  mint: string;
  project_document: string;
  terms: string;
  review: string;
  simulation: string;
  state: string;
  signed: string | null;
  signature: string | null;
  receipt: string | null;
  expires_at: string;
};
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
export function pumpLaunchRpc(): PumpLaunchRpc {
  const endpoint = getSolanaIndexerRpcEndpoint(),
    url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('Invalid launch provider.');
  return (method, params, signal) =>
    balanceRpc(endpoint, method, params, signal, fetch, 2097152);
}
export const publicPumpLaunch = (row: Row) => ({
  review: JSON.parse(row.review) as PumpSigningReview,
  simulation: JSON.parse(row.simulation),
  state: row.state,
  signature: row.signature,
  receipt: row.receipt ? JSON.parse(row.receipt) : null,
});
export async function getPumpLaunch(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare('SELECT * FROM pump_launch_reviews WHERE owner_id=? AND id=?')
    .bind(owner, id)
    .first<Row>();
  if (!row) return fail('Launch review not found.', 404);
  return row;
}
async function project(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(
      'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<{ document: string; updated_at: string; archived: number }>();
  if (!row || row.archived)
    return fail('Active launch project not found.', 404);
  const doc = validateProjectDocument(JSON.parse(row.document));
  if (
    doc.plan.developerBuy !== 0 ||
    doc.plan.holdersBuy !== 0 ||
    Number(doc.plan.holdersBuyQuote ?? 0) !== 0 ||
    doc.plan.scheduled
  )
    fail(
      'This launch creates the coin without initial buys. Set developer and holder buys to zero and disable scheduling, then save.',
    );
  return row;
}
export async function requirePumpLaunchAuthorityPolicy(
  sim: Pick<
    Awaited<ReturnType<typeof preflightOwnedPumpCreate>>['simulation'],
    'metadataUpdateAuthority' | 'metadataPointerAuthority' | 'mintAuthority'
  >,
  mint: string,
) {
  const pdas = await pumpCreateAddresses(mint);
  // New coin metadata must be immutable; minting may be retained only by Pump's PDA.
  const none = (v: unknown) =>
    v === null ||
    (!!v && typeof v === 'object' && '__option' in v && v.__option === 'None');
  if (
    !none(sim.metadataUpdateAuthority) ||
    !none(sim.metadataPointerAuthority) ||
    (sim.mintAuthority !== null && sim.mintAuthority !== pdas.mintAuthority)
  )
    fail('Simulated token authorities require a different launch policy.');
}
export async function preparePumpLaunch(
  db: D1Database,
  owner: string,
  terms: OwnedPumpTerms,
  signal: AbortSignal,
  rpc = pumpLaunchRpc(),
) {
  const saved = await project(db, owner, terms.projectId);
  if (saved.updated_at !== terms.updatedAt)
    fail('Save and review the current draft.');
  if (BigInt(terms.feeAndRentLimitRaw) > 1000000000n)
    fail('Review a fee and rent limit of at most 1 SOL.', 400);
  const existing = await db
    .prepare(
      "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND project_id=? AND state NOT IN ('cancelled','failed')",
    )
    .bind(owner, terms.projectId)
    .first<Row>();
  if (existing) return publicPumpLaunch(existing);
  let input: PumpCreateInput | undefined;
  const checked = await preflightOwnedPumpCreate(db, owner, terms, signal, {
    rpc,
    captureInput: (v) => {
      input = v;
    },
  });
  await requirePumpLaunchAuthorityPolicy(checked.simulation, terms.mint);
  if (!input || signal.aborted) fail('Launch preparation interrupted.');
  const review: PumpSigningReview = {
    id: crypto.randomUUID(),
    projectId: terms.projectId,
    projectUpdatedAt: terms.updatedAt,
    releaseId: terms.releaseId,
    expiresAt: checked.simulation.expiresAt,
    transaction: checked.packet.transaction,
    sha256: checked.packet.sha256,
    input: encodePumpSigningInput(input!),
    feeAndRentLimitRaw: terms.feeAndRentLimitRaw,
  };
  await requirePumpSigningReview(review);
  await db
    .prepare(
      "INSERT INTO pump_launch_reviews(id,owner_id,project_id,payer,mint,project_document,terms,review,simulation,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'review',?,?)",
    )
    .bind(
      review.id,
      owner,
      terms.projectId,
      terms.payer,
      terms.mint,
      saved.document,
      JSON.stringify(terms),
      JSON.stringify(review),
      JSON.stringify(checked.simulation),
      new Date().toISOString(),
      review.expiresAt,
    )
    .run();
  return publicPumpLaunch(await getPumpLaunch(db, owner, review.id));
}
async function refresh(
  db: D1Database,
  owner: string,
  row: Row,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const review = JSON.parse(row.review) as PumpSigningReview,
    terms = JSON.parse(row.terms) as OwnedPumpTerms;
  await requirePumpSigningReview(review);
  const saved = await project(db, owner, row.project_id);
  if (
    saved.document !== row.project_document ||
    saved.updated_at !== terms.updatedAt
  )
    fail('Saved launch changed.');
  const checked = await preflightOwnedPumpCreate(db, owner, terms, signal, {
    rpc,
    lifetime: {
      blockhash: review.input.blockhash,
      lastValidBlockHeight: review.input.lastValidBlockHeight,
    },
  });
  await requirePumpLaunchAuthorityPolicy(checked.simulation, row.mint);
  if (checked.packet.sha256 !== review.sha256)
    fail('Launch configuration changed. Prepare again.');
  return checked;
}
export async function actPumpLaunch(
  db: D1Database,
  owner: string,
  id: string,
  action: 'approve' | 'register' | 'submit' | 'recover' | 'cancel',
  payload: { sha256?: string; transaction?: string; approved?: boolean },
  signal: AbortSignal,
  rpc = pumpLaunchRpc(),
) {
  let row = await getPumpLaunch(db, owner, id);
  const review = JSON.parse(row.review) as PumpSigningReview;
  if ('create' in review.input)
    fail('Use the atomic initial-buy launch flow for this review.');
  const change = async (
    state: string,
    extraSql = '',
    extra: unknown[] = [],
  ) => {
    const changed = await db
      .prepare(
        `UPDATE pump_launch_reviews SET state=?${extraSql} WHERE owner_id=? AND id=? AND state=?`,
      )
      .bind(state, ...extra, owner, id, row.state)
      .run();
    if (!changed.meta.changes)
      fail('Launch state changed. Reload its saved review.');
    row = await getPumpLaunch(db, owner, id);
  };
  if (action === 'approve') {
    if (payload.approved !== true || payload.sha256 !== review.sha256)
      fail('Explicit approval of this exact launch is required.', 400);
    if (row.state === 'approved') return publicPumpLaunch(row);
    if (row.state !== 'review') fail('This launch cannot be approved again.');
    await refresh(db, owner, row, signal, rpc);
    if (signal.aborted) fail('Launch approval interrupted.');
    await change('approved');
  } else if (action === 'register') {
    if (typeof payload.transaction !== 'string')
      fail('Signed launch packet required.', 400);
    const signature = verifyPumpSignedPacket(review, payload.transaction!);
    if (row.signed === payload.transaction) return publicPumpLaunch(row);
    if (row.state !== 'approved')
      fail('Approve this exact launch before registering signatures.');
    // Preserve even expired signed packets for receipt recovery. Registration never sends.
    await change('signed', ',signed=?,signature=?', [
      payload.transaction,
      signature,
    ]);
  } else if (action === 'submit') {
    if (payload.approved !== true || payload.sha256 !== review.sha256)
      fail('Explicit broadcast approval is required.', 400);
    if (row.state !== 'signed') return publicPumpLaunch(row); // Never automatically resend an uncertain submission.
    if (
      !row.signed ||
      verifyPumpSignedPacket(review, row.signed) !== row.signature
    )
      fail('Saved signatures differ.');
    const checked = await refresh(db, owner, row, signal, rpc);
    if (signal.aborted) fail('Launch submission interrupted before sending.');
    await change('submitting'); // Persist first. A lost response remains recoverable.
    try {
      const signature = await rpc(
        'sendTransaction',
        [
          row.signed,
          {
            encoding: 'base64',
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 0,
            minContextSlot: checked.simulation.maximumSlot,
          },
        ],
        signal,
      );
      if (signature !== row.signature)
        fail('Provider returned a different signature. Recover status.');
      await change('submitted');
    } catch {
      return publicPumpLaunch(await getPumpLaunch(db, owner, id));
    }
  } else if (action === 'recover' || action === 'cancel') {
    if (
      !['review', 'approved', 'signed', 'submitting', 'submitted'].includes(
        row.state,
      )
    )
      return publicPumpLaunch(row);
    if (action === 'cancel' && row.state === 'review') {
      await change('cancelled');
      return publicPumpLaunch(row);
    }
    if ((await rpc('getGenesisHash', [], signal)) !== SOLANA_MAINNET_GENESIS)
      fail('Recovery RPC is not mainnet.');
    if (row.signature) {
      const result = (await rpc(
        'getTransaction',
        [
          row.signature,
          {
            encoding: 'base64',
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0,
          },
        ],
        signal,
      )) as {
        slot?: string;
        transaction?: [string, string];
        meta?: { err: unknown };
      } | null;
      if (result) {
        if (
          !result.meta ||
          !Object.hasOwn(result.meta, 'err') ||
          !result.transaction ||
          result.transaction[1] !== 'base64' ||
          result.transaction[0] !== row.signed ||
          !/^\d+$/.test(String(result.slot))
        )
          fail('Finalized launch receipt differs.');
        verifyPumpSignedPacket(review, result.transaction![0]);
        // A manually broadcast registered packet can land before our submit action.
        await change(
          result.meta!.err === null ? 'finalized' : 'failed',
          ',receipt=?',
          [
            JSON.stringify({
              network: 'mainnet',
              commitment: 'finalized',
              signature: row.signature,
              slot: String(result.slot),
              packetSha256: review.sha256,
              succeeded: result.meta!.err === null,
              observedAt: new Date().toISOString(),
            }),
          ],
        );
        return publicPumpLaunch(row);
      }
    }
    // Release only after finalized height invalidates every signature on this packet,
    // and the new mint is still absent. An ambiguous created mint keeps the reservation.
    const height = await rpc(
      'getBlockHeight',
      [{ commitment: 'finalized' }],
      signal,
    );
    if (
      typeof height === 'string' &&
      /^\d+$/.test(height) &&
      BigInt(height) > BigInt(review.input.lastValidBlockHeight) + 32n
    ) {
      const mint = (await rpc(
        'getAccountInfo',
        [row.mint, { encoding: 'base64', commitment: 'finalized' }],
        signal,
      )) as { value?: unknown };
      if (mint && mint.value === null) await change('cancelled');
    }
  }
  return publicPumpLaunch(row);
}
export async function listPumpLaunches(
  db: D1Database,
  owner: string,
  projectId: string,
) {
  const { results } = await db
    .prepare(
      "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND project_id=? AND json_type(terms,'$.maximumQuoteCostRaw') IS NULL AND COALESCE(json_extract(review,'$.format'),'')!='pump-create-holders-review-v1' ORDER BY created_at DESC LIMIT 20",
    )
    .bind(owner, projectId)
    .all<Row>();
  return results.map(publicPumpLaunch);
}

export function listPumpLaunchPage(
  db: D1Database,
  owner: string,
  projectId: string,
  page: PumpHistoryPage,
) {
  return readPumpHistoryPage(
    db,
    owner,
    projectId,
    'create',
    page,
    publicPumpLaunch,
  );
}
