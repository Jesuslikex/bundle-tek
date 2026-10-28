import {
  currentImportedPreparation,
  verifyExactSwapSignature,
} from './imported-swap-approval';
import {
  createJitoFinalization,
  requireJitoFinalization,
  type JitoFinalization,
} from './jito-finalization';
import { matchingJitoSwapReceipt } from './jito-swap-receipt';
import {
  createJitoChainObservation,
  requireJitoChainObservation,
  type JitoChainObservation,
} from './jito-chain-observation';
import { matchingJitoSettlementPolicy } from './jito-settlement-policy';
import { currentTradeSession } from './imported-trade-session-server';
import { currentImportedAcquisition } from './imported-acquisition-server';
import {
  restoreSavedSwapOrder,
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from './warmup-signing';
import { simulateImportedSwap } from './imported-swap-simulation';
import {
  prepareNativeWithdrawal,
  recheckNativeWithdrawal,
  decodeNativeWithdrawalReceipt,
} from './native-withdrawal-server';
import { inspectNativeWithdrawal, withdrawalInput } from './native-withdrawal';
import { formatNativeBalance } from './wallet-balance-format';
import { getSolanaRpcEndpoint } from './solana-rpc';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { getJitoTipAccounts, jitoRpc } from './jito-provider';
import {
  bundleFingerprint,
  requireJitoManifest,
  requireJitoSignatures,
  decodeJitoStatus,
  jitoIntentSelection,
  jitoTipLamports,
  type JitoBundleManifest,
  type JitoBundleRecord,
  type JitoBundleState,
} from './jito-bundle';
import type { SavedSwapPreparation } from './imported-swap-preparation-history';

type BundleRow = {
  document: string;
  state: JitoBundleState;
  bundleId: string | null;
  updatedAt: string;
};
type PacketRow = {
  packet: number;
  intentId: string | null;
  transaction: string | null;
  signature: string | null;
};
const JITO_EXPIRY_MARGIN_BLOCKS = 32n;
export async function readJitoBundle(
  db: D1Database,
  owner: string,
  id: string,
) {
  const row = await db
    .prepare(
      'SELECT document,state,bundle_id AS bundleId,updated_at AS updatedAt FROM jito_bundles WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<BundleRow>();
  if (!row) throw new Error('Owned bundle unavailable.');
  const manifest = await requireJitoManifest(JSON.parse(row.document), false);
  const { results: packets } = await db
    .prepare(
      'SELECT packet,intent_id AS intentId,`transaction`,signature FROM jito_bundle_packets WHERE owner_id=? AND bundle_id=? ORDER BY packet',
    )
    .bind(owner, id)
    .all<PacketRow>();
  if (
    packets.length !== manifest.swaps.length + 1 ||
    packets.some(
      (p, i) =>
        p.packet !== i ||
        p.intentId !== (manifest.swaps[i]?.id ?? null) ||
        Boolean(p.signature) !== Boolean(p.transaction),
    )
  )
    throw new Error('Bundle packet history differs.');
  const proofRow = await db
    .prepare(
      'SELECT document FROM jito_bundle_finalizations WHERE owner_id=? AND bundle_id=?',
    )
    .bind(owner, id)
    .first<{ document: string }>();
  const finalization = proofRow
    ? await requireJitoFinalization(
        JSON.parse(proofRow.document) as JitoFinalization,
        manifest,
        packets.map((p) => p.signature),
      )
    : null;
  if (finalization && row.state !== 'finalized')
    throw new Error('Finalization state differs.');
  return {
    row,
    manifest,
    packets,
    record: {
      finalization,
      manifest,
      state: row.state,
      bundleId: row.bundleId,
      signatures: packets.map((p) => p.signature),
      updatedAt: row.updatedAt,
    } satisfies JitoBundleRecord,
  };
}
async function currentSwap(
  db: D1Database,
  owner: string,
  review: WarmupSigningReview,
  signal: AbortSignal,
) {
  const captured = await currentImportedPreparation(
    db,
    owner,
    review.preparationId,
  );
  if (!captured)
    throw new Error('Project or wallet changed. Recover the bundle.');
  const saved: SavedSwapPreparation = {
    ...captured,
    document: JSON.parse(captured.document),
  };
  if (
    saved.document.conditional ||
    !review.session ||
    JSON.stringify(saved.document.session) !== JSON.stringify(review.session)
  )
    throw new Error('Choose ordinary session entries for a Jito bundle.');
  await currentTradeSession(db, owner, saved, review.id);
  if (review.acquisition)
    await currentImportedAcquisition(db, owner, review.acquisition, true);
  const order = await restoreSavedSwapOrder(saved, review.transaction);
  const simulation = await simulateImportedSwap(order, signal, fetch, true);
  const settlement = await requireWarmupSigningReview(order, simulation);
  if (
    !matchingJitoSettlementPolicy(review.settlement, settlement) ||
    simulation.networkFeeLamports !== review.maximumFeeLamports
  )
    throw new Error('Approved swap fees, rent or settlement changed.');
  const again = await currentImportedPreparation(
    db,
    owner,
    review.preparationId,
  );
  if (!again || again.document !== captured.document)
    throw new Error('Preparation changed during review.');
  return saved;
}
async function rpcForBundle(signal: AbortSignal) {
  const endpoint = getSolanaRpcEndpoint('mainnet');
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(endpoint, method, params, signal, fetch);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Bundle RPC network differs.');
  return rpc;
}
async function combinedTipBalance(
  manifest: Pick<JitoBundleManifest, 'swaps' | 'tip'>,
  signal: AbortSignal,
) {
  const rpc = await rpcForBundle(signal);
  const balance = (await rpc('getBalance', [
    manifest.tip.wallet,
    { commitment: 'finalized', minContextSlot: manifest.tip.slot },
  ])) as { value: string };
  if (
    !manifest.swaps[0].settlement ||
    !/^(0|[1-9]\d{0,19})$/.test(balance?.value)
  )
    throw new Error('Tip payer balance unavailable.');
  const needed =
    BigInt(manifest.tip.maximumDebitRaw) +
    BigInt(manifest.tip.reserveLamports) +
    BigInt(manifest.swaps[0].settlement.maximumNativeDebitLamports);
  if (BigInt(balance.value) < needed)
    throw new Error(
      'Tip payer must cover its swap, tip, both fees and reserve without relying on earlier bundle proceeds.',
    );
}
export async function createJitoBundle(
  db: D1Database,
  owner: string,
  input: {
    projectId: string;
    sessionId: string;
    sessionRevision: number;
    intentIds: string[];
    tipLamports: string;
  },
  signal: AbortSignal,
  freshlySimulated = false,
) {
  jitoIntentSelection(input.intentIds);
  const tipLamports = jitoTipLamports(input.tipLamports);
  const retained = await db
    .prepare(
      'SELECT count(*) AS count FROM jito_bundles WHERE owner_id=? AND project_id=?',
    )
    .bind(owner, input.projectId)
    .first<{ count: number }>();
  if (!retained || retained.count >= 20)
    throw new Error('Bundle history capacity reached for this project.');
  const reviews: WarmupSigningReview[] = [];
  for (const id of input.intentIds) {
    const row = await db
      .prepare(
        "SELECT i.document FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id WHERE i.owner_id=? AND i.id=? AND p.project_id=? AND i.state='awaiting_signature' AND i.signature IS NULL AND NOT EXISTS(SELECT 1 FROM jito_bundle_packets bp WHERE bp.owner_id=i.owner_id AND bp.intent_id=i.id)",
      )
      .bind(owner, id, input.projectId)
      .first<{ document: string }>();
    if (!row)
      throw new Error(
        'Choose current unsigned approvals that are not already bundled.',
      );
    const review = JSON.parse(row.document) as WarmupSigningReview;
    if (
      review.id !== id ||
      review.session?.sessionId !== input.sessionId ||
      review.session?.sessionRevision !== input.sessionRevision
    )
      throw new Error('Approval belongs to another session revision.');
    reviews.push(review);
  }
  reviews.sort((a, b) => a.session!.entry - b.session!.entry);
  const saved = await Promise.all(
    reviews.map(async (r) => {
      if (!freshlySimulated) return currentSwap(db, owner, r, signal);
      const captured = await currentImportedPreparation(
        db,
        owner,
        r.preparationId,
      );
      if (!captured)
        throw new Error('Project or wallet changed during preparation.');
      return {
        ...captured,
        document: JSON.parse(captured.document),
      } as SavedSwapPreparation;
    }),
  );
  if (
    new Set(saved.map((s) => s.document.side)).size !== 1 ||
    new Set(saved.map((s) => s.projectRevision)).size !== 1
  )
    throw new Error('Bundle must have one side and project revision.');
  const tips = await getJitoTipAccounts(signal);
  const random = crypto.getRandomValues(new Uint32Array(1))[0] % tips.length;
  const tip = await prepareNativeWithdrawal(
    withdrawalInput(
      reviews[0].wallet,
      tips[random],
      formatNativeBalance(tipLamports, 9),
      saved[0].walletRevision,
    ),
    signal,
  );
  const expiresAt = new Date(
    Math.min(
      Date.parse(tip.expiresAt),
      ...reviews.map((r) => Date.parse(r.expiresAt)),
    ),
  ).toISOString();
  if (Date.parse(expiresAt) - Date.now() < 15000)
    throw new Error(
      'Bundle has less than 15 seconds left. Cancel unsigned approvals and prepare fresh packets.',
    );
  const terms = {
    format: 'jito-atomic-bundle-v1' as const,
    id: crypto.randomUUID(),
    projectId: input.projectId,
    sessionId: input.sessionId,
    sessionRevision: input.sessionRevision,
    createdAt: new Date().toISOString(),
    expiresAt,
    swaps: reviews,
    tip,
  };
  const manifest: JitoBundleManifest = {
    ...terms,
    sha256: await bundleFingerprint(terms),
  };
  await requireJitoManifest(manifest);
  await combinedTipBalance(manifest, signal);
  // Recheck after provider work; SQL attachment guards close concurrent signing/cancellation races.
  for (let i = 0; i < saved.length; i++)
    await currentTradeSession(db, owner, saved[i], reviews[i].id);
  await db.batch([
    db
      .prepare("INSERT INTO jito_bundles VALUES(?,?,?,?,?,'reviewed',NULL,?,?)")
      .bind(
        owner,
        manifest.id,
        manifest.projectId,
        manifest.sessionId,
        JSON.stringify(manifest),
        manifest.createdAt,
        manifest.createdAt,
      ),
    ...[...reviews.map((r) => r.id), null].map((id, i) =>
      db
        .prepare('INSERT INTO jito_bundle_packets VALUES(?,?,?,?,NULL,NULL)')
        .bind(owner, manifest.id, i, id),
    ),
  ]);
  return (await readJitoBundle(db, owner, manifest.id)).record;
}
export async function registerJitoPacket(
  db: D1Database,
  owner: string,
  id: string,
  digest: string,
  packet: number,
  transaction: string,
) {
  const bundle = await readJitoBundle(db, owner, id);
  await requireJitoManifest(bundle.manifest, false);
  if (
    bundle.manifest.sha256 !== digest ||
    bundle.row.state !== 'reviewed' ||
    !Number.isInteger(packet) ||
    packet < 0 ||
    packet > bundle.manifest.swaps.length
  )
    throw new Error('Current complete bundle approval required.');
  const review = bundle.manifest.swaps[packet];
  const signature = review
    ? verifyExactSwapSignature(review, transaction)
    : (await inspectNativeWithdrawal(bundle.manifest.tip, transaction, true))
        .signature!;
  const existing = bundle.packets[packet];
  if (existing.signature) {
    if (
      existing.signature !== signature ||
      existing.transaction !== transaction
    )
      throw new Error('Registered bundle packet differs.');
    return bundle.record;
  }
  const now = new Date().toISOString();
  await db.batch([
    ...(review
      ? [
          db
            .prepare(
              "UPDATE imported_swap_signing_intents SET state='signed',signature=?,updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature' AND signature IS NULL AND document=?",
            )
            .bind(signature, now, owner, review.id, JSON.stringify(review)),
        ]
      : []),
    db
      .prepare(
        'UPDATE jito_bundle_packets SET `transaction`=?,signature=? WHERE owner_id=? AND bundle_id=? AND packet=? AND signature IS NULL',
      )
      .bind(transaction, signature, owner, id, packet),
  ]);
  return (await readJitoBundle(db, owner, id)).record;
}
export async function submitJitoBundle(
  db: D1Database,
  owner: string,
  id: string,
  digest: string,
  signal: AbortSignal,
) {
  const bundle = await readJitoBundle(db, owner, id);
  await requireJitoManifest(bundle.manifest);
  if (
    bundle.manifest.sha256 !== digest ||
    bundle.row.state !== 'reviewed' ||
    bundle.packets.some((p) => !p.transaction || !p.signature)
  )
    throw new Error(
      'Sign every exact packet, then approve one bundle submission.',
    );
  requireJitoSignatures(bundle.packets.map((p) => p.signature!));
  for (let i = 0; i < bundle.manifest.swaps.length; i++) {
    if (
      verifyExactSwapSignature(
        bundle.manifest.swaps[i],
        bundle.packets[i].transaction!,
      ) !== bundle.packets[i].signature
    )
      throw new Error('Stored bundle packet differs.');
  }
  await inspectNativeWithdrawal(
    bundle.manifest.tip,
    bundle.packets.at(-1)!.transaction!,
    true,
  );
  await Promise.all(
    bundle.manifest.swaps.map((review) =>
      currentSwap(db, owner, review, signal),
    ),
  );
  const tips = await getJitoTipAccounts(signal);
  if (!tips.includes(bundle.manifest.tip.recipient))
    throw new Error('Reviewed tip recipient is no longer reported by Jito.');
  await recheckNativeWithdrawal(bundle.manifest.tip, signal);
  await combinedTipBalance(bundle.manifest, signal);
  signal.throwIfAborted();
  const claim = await db
    .prepare(
      "UPDATE jito_bundles SET state='submitting',updated_at=? WHERE owner_id=? AND id=? AND state='reviewed' AND document=?",
    )
    .bind(new Date().toISOString(), owner, id, bundle.row.document)
    .run();
  if ((claim.success as boolean) === false || claim.meta?.changes !== 1)
    throw new Error('Bundle submission already started or context changed.');
  const retained = await readJitoBundle(db, owner, id);
  if (
    retained.row.state !== 'submitting' ||
    retained.row.document !== bundle.row.document ||
    retained.packets.some(
      (p, index) =>
        p.transaction !== bundle.packets[index].transaction ||
        p.signature !== bundle.packets[index].signature,
    )
  )
    throw new Error(
      'Bundle send marker is not durably acknowledged. Recover, do not resend.',
    );
  signal.throwIfAborted();
  await requireJitoManifest(bundle.manifest);
  // Exactly one transport attempt. Timeouts and malformed acknowledgements retain submitting.
  try {
    const bundleId = await jitoRpc(
      'sendBundle',
      [bundle.packets.map((p) => p.transaction!), { encoding: 'base64' }],
      signal,
    );
    if (typeof bundleId !== 'string' || !/^[a-f0-9]{64}$/.test(bundleId))
      throw new Error();
    await db
      .prepare(
        "UPDATE jito_bundles SET state='submitted',bundle_id=?,updated_at=? WHERE owner_id=? AND id=? AND state='submitting' AND bundle_id IS NULL",
      )
      .bind(bundleId, new Date().toISOString(), owner, id)
      .run();
  } catch {
    /* Signed packets stay reserved. Recovery never resends. */
  }
  return (await readJitoBundle(db, owner, id)).record;
}
export async function cancelJitoBundle(
  db: D1Database,
  owner: string,
  id: string,
) {
  const result = await db
    .prepare(
      "UPDATE jito_bundles SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND state='reviewed' AND NOT EXISTS(SELECT 1 FROM jito_bundle_packets WHERE owner_id=? AND bundle_id=? AND signature IS NOT NULL)",
    )
    .bind(new Date().toISOString(), owner, id, owner, id)
    .run();
  if (!result.meta.changes)
    throw new Error(
      'Only entirely unsigned bundles can be cancelled. Signed packets require recovery.',
    );
  return (await readJitoBundle(db, owner, id)).record;
}
export async function observeJitoBundle(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  recoverSwap: (id: string) => Promise<unknown>,
) {
  return (
    await observeJitoBundleInternal(db, owner, id, signal, recoverSwap, false)
  ).record;
}

/** The report is optional, transient provider data; the record is unchanged. */
export async function observeJitoBundleWithObservation(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  recoverSwap: (id: string) => Promise<unknown>,
) {
  return observeJitoBundleInternal(db, owner, id, signal, recoverSwap, true);
}

async function observeJitoBundleInternal(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  recoverSwap: (id: string) => Promise<unknown>,
  includeObservation: boolean,
) {
  const bundle = await readJitoBundle(db, owner, id);
  if (['cancelled', 'expired', 'finalized'].includes(bundle.row.state))
    return { record: bundle.record, observation: null };
  const rpc = await rpcForBundle(signal);
  const signatures = bundle.packets
    .filter((p) => p.signature)
    .map((p) => p.signature!);
  if (!signatures.length) return { record: bundle.record, observation: null };
  const raw = (await rpc('getSignatureStatuses', [
    signatures,
    { searchTransactionHistory: true },
  ])) as {
    value?: Array<null | {
      slot: string;
      err: unknown;
      confirmationStatus: string;
    }>;
  };
  if (!Array.isArray(raw?.value) || raw.value.length !== signatures.length)
    throw new Error('Signature recovery unavailable. Reservations retained.');
  let observation: JitoChainObservation | null = null;
  if (includeObservation) {
    try {
      observation = createJitoChainObservation(
        bundle.record,
        raw,
        new Date().toISOString(),
      );
    } catch {
      // Optional diagnostics must not affect recovery or expose provider data.
    }
  }
  const all = signatures.length === bundle.packets.length;
  const finalized =
    all &&
    raw.value.every(
      (s) =>
        s?.confirmationStatus === 'finalized' &&
        s.err === null &&
        /^\d+$/.test(s.slot),
    ) &&
    new Set(raw.value.map((s) => s!.slot)).size === 1;
  if (finalized) {
    const slot = Number(raw.value[0]!.slot);
    if (!Number.isSafeInteger(slot) || slot < 1)
      throw new Error('Finalized slot unavailable.');
    if (bundle.row.bundleId) {
      const status = decodeJitoStatus(
        await jitoRpc('getBundleStatuses', [[bundle.row.bundleId]], signal),
        bundle.row.bundleId,
        signatures,
      );
      if (status && status.slot !== slot)
        throw new Error(
          'Jito and chain slot evidence differ. Reservations retained.',
        );
    }
    const tipRaw = (await rpc('getTransaction', [
      signatures.at(-1),
      {
        encoding: 'base64',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      },
    ])) as {
      slot?: string;
      meta?: { err?: unknown };
      transaction?: [string, string];
    };
    if (
      !tipRaw ||
      Number(tipRaw.slot) !== slot ||
      tipRaw.meta?.err !== null ||
      tipRaw.transaction?.[1] !== 'base64' ||
      (
        await inspectNativeWithdrawal(
          bundle.manifest.tip,
          tipRaw.transaction[0],
          true,
        )
      ).signature !== signatures.at(-1)
    )
      throw new Error('Finalized tip packet differs.');
    const tipReceipt = await decodeNativeWithdrawalReceipt(
      tipRaw,
      bundle.manifest.tip,
      signatures.at(-1)!,
    );
    if (!('amountRaw' in tipReceipt) || tipReceipt.slot !== slot)
      throw new Error('Finalized tip settlement differs.');
    for (const [index, review] of bundle.manifest.swaps.entries())
      if (
        !matchingJitoSwapReceipt(
          await recoverSwap(review.id),
          bundle.manifest.projectId,
          review,
          signatures[index],
          slot,
        )
      )
        throw new Error(
          'Exact finalized swap receipt still unavailable. Retry recovery, not submission.',
        );
    if (!['submitted', 'submitting'].includes(bundle.row.state))
      throw new Error(
        'Packets landed outside this app’s bundle submission. Review the chain evidence.',
      );
    const finalization = await createJitoFinalization(
      bundle.manifest,
      signatures,
      slot,
      new Date().toISOString(),
      tipReceipt,
    );
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      throw new Error(
        'Bundle recovery network changed. Reservations retained.',
      );
    signal.throwIfAborted();
    await db.batch([
      db
        .prepare(
          'INSERT INTO jito_bundle_finalizations(owner_id,bundle_id,document,observed_at) VALUES(?,?,?,?)',
        )
        .bind(owner, id, JSON.stringify(finalization), finalization.observedAt),
      db
        .prepare(
          "UPDATE jito_bundles SET state='finalized',updated_at=? WHERE owner_id=? AND id=? AND state IN ('submitting','submitted')",
        )
        .bind(finalization.observedAt, owner, id),
    ]);
  } else if (raw.value.every((s) => s === null)) {
    const height = (await rpc('getBlockHeight', [
      { commitment: 'finalized', minContextSlot: bundle.manifest.tip.slot },
    ])) as string;
    const maximum = [
      bundle.manifest.tip.lastValidBlockHeight,
      ...bundle.manifest.swaps.map((s) => s.lastValidBlockHeight),
    ].reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
    // Keep the same conservative block-height margin as launch recovery.
    if (
      /^\d+$/.test(height) &&
      BigInt(height) > BigInt(maximum) + JITO_EXPIRY_MARGIN_BLOCKS
    ) {
      for (const signature of signatures)
        if (
          (await rpc('getTransaction', [
            signature,
            {
              commitment: 'finalized',
              encoding: 'base64',
              maxSupportedTransactionVersion: 0,
            },
          ])) !== null
        )
          throw new Error(
            'Historical transaction found. Keep recovery active.',
          );
      if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
        throw new Error(
          'Bundle recovery network changed. Reservations retained.',
        );
      signal.throwIfAborted();
      await db
        .prepare(
          "UPDATE jito_bundles SET state='expired',updated_at=? WHERE owner_id=? AND id=? AND state IN ('reviewed','submitting','submitted')",
        )
        .bind(new Date().toISOString(), owner, id)
        .run();
    }
  }
  // Partial, failed, processed or missing evidence never establishes atomic success.
  const latest = (await readJitoBundle(db, owner, id)).record;
  if (
    observation &&
    latest.manifest.sha256 === bundle.manifest.sha256 &&
    latest.manifest.id === bundle.manifest.id &&
    latest.state === bundle.record.state &&
    latest.updatedAt === bundle.record.updatedAt &&
    JSON.stringify(latest.signatures) ===
      JSON.stringify(bundle.record.signatures)
  ) {
    try {
      return {
        record: latest,
        observation: requireJitoChainObservation(observation, latest),
      };
    } catch {
      // Drift or malformed optional diagnostics never alter retained state.
    }
  }
  return { record: latest, observation: null };
}
