import { collectOwnedPumpGroupObservation } from './pump-launch-group-observation-service';
import { readPumpLaunchGroupReview } from './pump-launch-group-review-service';
import {
  pumpUnsignedInteger,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from './pump-holder-review';
import {
  readOwnedPumpGroupBroadcast,
  pumpGroupBroadcastFail,
  type PumpGroupJitoRpc,
} from './pump-group-broadcast-service';
import { jitoRpc } from './jito-provider';
import {
  pumpGroupJitoStatus,
  type PumpGroupBroadcastRecovery,
  type PumpGroupBroadcastTerminalReceipt,
} from './pump-group-broadcast';
const fail = pumpGroupBroadcastFail;
const rec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
/** Finalized chain bytes and balance effects are authoritative. Jito acknowledgements/status are supporting evidence only. */
export async function recoverOwnedPumpGroupBroadcast(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
  jito: PumpGroupJitoRpc = jitoRpc,
) {
  signal.throwIfAborted();
  const saved = await readOwnedPumpGroupBroadcast(db, owner, id);
  if (!saved) return fail('No owned group broadcast review is available.');
  const group = await readPumpLaunchGroupReview(db, owner, id);
  if (group.receipt) {
    const closure = await db
      .prepare(
        'SELECT receipt FROM pump_group_broadcast_closures WHERE owner_id=? AND review_id=?',
      )
      .bind(owner, id)
      .first<{ receipt: string }>();
    if (!closure || closure.receipt !== canonicalPumpHolderJson(group.receipt))
      return fail('Saved broadcast closure proof differs.');
    return { group, broadcast: saved };
  }
  if (group.state !== 'signed' || !group.signedEvidence)
    return fail('Recover the exact retained signed group.');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const observed = await collectOwnedPumpGroupObservation(
    db,
    owner,
    id,
    deadline,
    rpc,
  );
  if ((await rpc('getGenesisHash', [], deadline)) !== SOLANA_MAINNET_GENESIS)
    return fail('Broadcast recovery provider network differs.');
  const tip: PumpGroupBroadcastRecovery['tip'] = {
    signature: saved.tip?.signature ?? null,
    finalized: false,
    succeeded: null,
    slot: null,
    networkFeeRaw: null,
    tipDebitRaw: null,
  };
  if (saved.tip) {
    const result = await rpc(
      'getTransaction',
      [
        saved.tip.signature,
        {
          encoding: 'base64',
          commitment: 'finalized',
          maxSupportedTransactionVersion: 1,
        },
      ],
      deadline,
    );
    if (result !== null) {
      if (
        !rec(result) ||
        !rec(result.meta) ||
        !Object.hasOwn(result.meta, 'err') ||
        result.meta.err === undefined ||
        !Array.isArray(result.transaction) ||
        result.transaction.length !== 2 ||
        result.transaction[0] !== saved.tip.transaction ||
        result.transaction[1] !== 'base64' ||
        !Array.isArray(result.meta.preBalances) ||
        !Array.isArray(result.meta.postBalances) ||
        result.meta.preBalances.length !== 3 ||
        result.meta.postBalances.length !== 3 ||
        (result.meta.err !== null &&
          typeof result.meta.err !== 'string' &&
          !rec(result.meta.err))
      )
        return fail('Finalized tip bytes or balance evidence differs.');
      const slot = pumpUnsignedInteger(result.slot),
        fee = pumpUnsignedInteger(result.meta.fee);
      if (
        !slot ||
        slot > BigInt(Number.MAX_SAFE_INTEGER) ||
        fee < 1n ||
        fee > BigInt(saved.review.tipFeeLimitRaw)
      )
        return fail('Finalized tip slot or fee exceeds the approved profile.');
      const before = result.meta.preBalances.map(pumpUnsignedInteger),
        after = result.meta.postBalances.map(pumpUnsignedInteger),
        debit = result.meta.err === null ? BigInt(saved.review.tipRaw) : 0n;
      if (
        before[0] - after[0] !== debit + fee ||
        after[1] - before[1] !== debit ||
        before[2] !== after[2]
      )
        return fail('Finalized tip amount or network fee differs.');
      Object.assign(tip, {
        finalized: true,
        succeeded: result.meta.err === null,
        slot: slot.toString(),
        networkFeeRaw: fee.toString(),
        tipDebitRaw: debit.toString(),
      });
    }
  }
  const bundle: PumpGroupBroadcastRecovery['bundle'] = {
    bundleId: saved.result?.bundleId ?? null,
    finalized: false,
    slot: null,
  };
  if (bundle.bundleId) {
    try {
      const result = await jito(
        'getBundleStatuses',
        [[bundle.bundleId]],
        deadline,
      );
      if (saved.tip)
        Object.assign(
          bundle,
          pumpGroupJitoStatus(result, bundle.bundleId, [
            ...group.signedEvidence.packets.map((p) => p.signature),
            saved.tip.signature,
          ]),
        );
    } catch {
      /* Status retention and transport availability cannot erase chain evidence. */
    }
  }
  let expiry: PumpGroupBroadcastRecovery['expiry'] = null;
  if (!tip.finalized) {
    const floor = Math.max(
      0,
      ...[
        observed.receipt.expiry?.expiryBankSlot ?? null,
        ...observed.receipt.packets.map((p) => p.slot),
      ]
        .filter((v): v is string => v !== null)
        .map(Number),
    );
    const epoch = await rpc(
      'getEpochInfo',
      [{ commitment: 'finalized', ...(floor ? { minContextSlot: floor } : {}) }],
      deadline,
    );
    if (!rec(epoch)) return fail('Tip expiry observation is missing.');
    const bankSlot = pumpUnsignedInteger(epoch.absoluteSlot),
      height = pumpUnsignedInteger(epoch.blockHeight),
      last = BigInt(saved.review.lastValidBlockHeight);
    if (
      bankSlot < BigInt(floor) ||
      bankSlot > BigInt(Number.MAX_SAFE_INTEGER) ||
      height > bankSlot
    )
      return fail('Tip expiry height and slot are not linked.');
    expiry = {
      lastValidBlockHeight: last.toString(),
      finalizedBlockHeight: height.toString(),
      expiryBankSlot: bankSlot.toString(),
      pastExpiryMargin: height > last + 32n,
      marginBlocks: 32,
    };
  }
  const allKnown =
    !observed.receipt.networkFeeUnresolved && tip.networkFeeRaw !== null;
  const packetCount = observed.receipt.packets.length,
    landed = observed.receipt.observedPacketCount,
    succeeded = observed.receipt.successfulPacketCount;
  // Nothing further can change: every launch packet and the tip finalized with a
  // known fee, or their shared blockhash is provably past the expiry margin.
  // A tip that landed alone after the launch packets expired (with finalized mint
  // absence) is settled too: the tip was paid and nothing else can land.
  const settled =
    (landed > 0 ||
      (observed.state === 'expired-unobserved' && tip.finalized)) &&
    observed.receipt.packets.every((p) =>
      p.finalized
        ? p.networkFeeRaw !== null
        : observed.receipt.expiry?.pastExpiryMargin === true,
    ) &&
    (tip.finalized || expiry?.pastExpiryMargin === true);
  const commonSlot =
    tip.slot !== null &&
    observed.receipt.packets.every((p) => p.slot === tip.slot);
  const state: PumpGroupBroadcastRecovery['state'] =
    observed.state === 'complete' &&
    tip.finalized &&
    tip.succeeded === true &&
    commonSlot &&
    allKnown
      ? 'finalized'
      : observed.state === 'failed' &&
          tip.finalized &&
          tip.succeeded === false &&
          allKnown
        ? 'failed'
        : observed.state === 'expired-unobserved' && !tip.finalized
          ? 'expired-unobserved'
          : settled
            ? 'partial-final'
            : observed.receipt.observedPacketCount > 0 || tip.finalized
              ? 'partial'
              : observed.state === 'pending'
                ? 'pending'
                : 'unknown';
  const partialGuard =
    state === 'partial-final'
      ? await db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='pump_group_broadcast_closure_insert'",
          )
          .first<{ sql: string }>()
      : null;
  // A database without the partial closure guard keeps reservations held.
  const released =
    ['finalized', 'failed', 'expired-unobserved'].includes(state) ||
    (state === 'partial-final' && !!partialGuard?.sql.includes('partial-final'));
  const closureState =
    state === 'partial-final'
      ? succeeded === packetCount
        ? 'finalized'
        : 'failed'
      : state === 'expired-unobserved'
        ? 'cancelled'
        : state;
  if ((await rpc('getGenesisHash', [], deadline)) !== SOLANA_MAINNET_GENESIS)
    return fail('Broadcast recovery network changed.');
  deadline.throwIfAborted();
  const body = {
    format: 'pump-group-jito-recovery-v1' as const,
    id: crypto.randomUUID(),
    reviewId: id,
    broadcastId: saved.review.id,
    broadcastSha256: saved.review.sha256,
    signedGroupSha256: saved.review.signedGroupSha256,
    observedAt: new Date().toISOString(),
    state,
    groupObservationId: observed.id,
    groupObservationSha256: observed.sha256,
    tip,
    bundle,
    expiry,
    reservationsReleased: false,
    economicSettlementVerified: false as const,
    completeLaunch: false as const,
  };
  const recovery = { ...body, sha256: await pumpHolderDigest(body) };
  try {
    await db
      .prepare(
        'INSERT INTO pump_group_broadcast_observations(id,review_id,broadcast_id,owner_id,observation,sha256,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        recovery.id,
        id,
        saved.review.id,
        owner,
        canonicalPumpHolderJson(recovery),
        recovery.sha256,
        recovery.observedAt,
      )
      .run();
    if (released) {
      const receipt: PumpGroupBroadcastTerminalReceipt = {
        format: 'pump-launch-group-broadcast-terminal-v1',
        kind:
          state === 'partial-final'
            ? 'partial'
            : (state as 'finalized' | 'failed' | 'expired-unobserved'),
        ...(state === 'partial-final'
          ? {
              packetCount,
              landedPacketCount: landed,
              succeededPacketCount: succeeded,
            }
          : {}),
        reviewId: id,
        contextSha256: group.review.contextSha256,
        manifestSha256: group.review.manifestSha256,
        signedGroupSha256: saved.review.signedGroupSha256,
        broadcastId: saved.review.id,
        broadcastSha256: saved.review.sha256,
        observationId: recovery.id,
        observationSha256: recovery.sha256,
        observedAt: recovery.observedAt,
        sourceState: 'signed',
        knownNetworkFeeRaw: (
          BigInt(observed.receipt.knownNetworkFeeRaw) +
          BigInt(tip.networkFeeRaw ?? '0')
        ).toString(),
        groupNetworkFeeRaw: observed.receipt.knownNetworkFeeRaw,
        tipNetworkFeeRaw: tip.networkFeeRaw,
        tipDebitRaw: tip.tipDebitRaw,
        // Unlanded packets of a settled partial outcome never paid a fee.
        networkFeeUnresolved: state === 'partial-final' ? false : !allKnown,
        reservationsReleased: true,
        economicSettlementVerified: false,
        signingAllowed: false,
        executionAllowed: false,
        completeLaunch: false,
        atomicity: 'jito-transport-requested-not-proven',
      };
      await db
        .prepare(
          'INSERT INTO pump_group_broadcast_closures(review_id,owner_id,observation_id,receipt,state,created_at) VALUES(?,?,?,?,?,?)',
        )
        .bind(
          id,
          owner,
          recovery.id,
          canonicalPumpHolderJson(receipt),
          closureState,
          recovery.observedAt,
        )
        .run();
    }
  } catch {
    const raced = await readOwnedPumpGroupBroadcast(db, owner, id);
    if (
      raced?.reservationsReleased &&
      raced.review.sha256 === saved.review.sha256
    )
      return {
        group: await readPumpLaunchGroupReview(db, owner, id),
        broadcast: raced,
      };
    return fail(
      'Broadcast recovery proof or group changed before closure. Reservations remain held until its saved closure is confirmed.',
    );
  }
  return {
    group: await readPumpLaunchGroupReview(db, owner, id),
    broadcast: await readOwnedPumpGroupBroadcast(db, owner, id),
  };
}
