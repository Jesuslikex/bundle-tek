import { expect, it } from 'vitest';
import { volumeReservationFixture } from '../test/volume-reservation-fixture';
import { volumePumpSettlementFixture } from '../test/volume-pump-settlement-fixture';
import {
  bindVolumeRecoveryPacket,
  readVolumeSettlementRecovery,
  recoverVolumeBundleSettlement,
  type VolumeRecoveryRpc,
} from './volume-bundle-recovery';
import {
  markVolumeBundleAttempted,
  readVolumeBundleReservation,
  readVolumeBundleTipBudget,
  cancelVolumeBundleReservation,
  reserveVolumeBundleRound,
} from './volume-bundle-reservations';
import {
  verifyVolumePumpSettlement,
  verifyVolumeBundleSettlement,
} from './volume-bundle-settlement';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { volumeDigest } from './volume-bundle-construction';
async function fixture() {
  const f = await volumeReservationFixture(),
    receipt = await volumePumpSettlementFixture();
  expect(f.review.sha256).toBe(receipt.review.sha256);
  await f.reserve();
  const attempt = crypto.randomUUID();
  await markVolumeBundleAttempted(f.db, 'owner', f.request.id, attempt);
  await bindVolumeRecoveryPacket(
    f.db,
    'owner',
    f.request.id,
    attempt,
    receipt.packet,
  );
  const calls: string[] = [];
  const rpc: VolumeRecoveryRpc = async (method, params) => {
    calls.push(method);
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    expect(params).toEqual([
      receipt.receipt.signature,
      {
        commitment: 'finalized',
        encoding: 'base64',
        maxSupportedTransactionVersion: 0,
      },
    ]);
    return structuredClone(receipt.receipt.result);
  };
  return {
    ...f,
    ...receipt,
    attempt,
    rpc,
    calls,
    recover: () =>
      recoverVolumeBundleSettlement(
        f.db,
        'owner',
        f.request.id,
        rpc,
        new AbortController().signal,
      ),
  };
}
it('verifies direct Pump SOL sells without weakening the generic policy', async () => {
  const f = await volumePumpSettlementFixture();
  await expect(
    verifyVolumeBundleSettlement(f.review, f.receipt),
  ).rejects.toThrow();
  expect(
    await verifyVolumePumpSettlement(f.review, f.route, f.receipt),
  ).toMatchObject({
    buyLamports: '50000000',
    sellLamports: '49900000',
    tipLamports: '2000',
    netLamports: '-107000',
    pumpAccountingVerified: true,
    executionAllowed: false,
  });
});
it('recovers after parent archive, persists proof, charges actual tip, frees wallet and prevents round replay', async () => {
  const f = await fixture();
  await f.client.execute(
    'UPDATE imported_token_projects SET archived=1,revision=2',
  );
  await f.client.execute('UPDATE workspace_wallets SET archived=1,revision=2');
  const saved = await f.recover();
  expect(saved).toMatchObject({
    format: 'volume-settlement-recovery-v1',
    executionAllowed: false,
    historicalCodeAttested: false,
  });
  expect(
    (await readVolumeBundleReservation(f.db, 'owner', f.request.id))?.state,
  ).toBe('settled');
  expect(
    await readVolumeBundleTipBudget(f.db, 'owner', f.saved.id),
  ).toMatchObject({
    heldLamports: '0',
    spentLamports: '2000',
    availableLamports: '998000',
  });
  expect(
    await readVolumeSettlementRecovery(f.db, 'owner', f.request.id),
  ).toEqual(saved);
  expect(await f.recover()).toEqual(saved);
  expect(f.calls).toEqual([
    'getGenesisHash',
    'getTransaction',
    'getGenesisHash',
  ]);
  expect(
    await bindVolumeRecoveryPacket(
      f.db,
      'owner',
      f.request.id,
      f.attempt,
      f.packet,
    ),
  ).toMatchObject({ signature: f.receipt.signature });
  await f.client.execute({
    sql: "INSERT INTO solana_execution_reservations VALUES('owner',?,'test','x','reserved')",
    args: [f.review.wallet],
  });
  await expect(
    cancelVolumeBundleReservation(f.db, 'owner', f.request.id),
  ).rejects.toThrow();
  const events = await f.client.execute(
    'SELECT state FROM volume_bundle_reservation_events ORDER BY sequence',
  );
  expect(events.rows.map((r) => r.state)).toEqual([
    'held',
    'attempted',
    'settled',
  ]);
});
it('resolves concurrent recovery exactly once with immutable retained records', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.recover(), f.recover()]);
  expect(a).toEqual(b);
  await expect(
    reserveVolumeBundleRound(
      f.db,
      'owner',
      { ...f.request, id: crypto.randomUUID() },
      f.deps,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/UNIQUE/);
  expect(
    (
      await f.client.execute(
        'SELECT COUNT(*) AS n FROM volume_bundle_settlements',
      )
    ).rows[0].n,
  ).toBe(1);
  for (const table of [
    'volume_bundle_settlements',
    'volume_bundle_recovery_packets',
  ]) {
    await expect(f.client.execute(`DELETE FROM ${table}`)).rejects.toThrow(
      /retained/,
    );
    await expect(
      f.client.execute(`UPDATE ${table} SET owner_id='other'`),
    ).rejects.toThrow(/immutable/);
  }
});
it.each([
  'missing',
  'failed',
  'network',
  'wrong-packet',
  'wrong-slot',
  'wrong-tip',
  'wrong-token',
  'unexpected-native',
  'wrong-inner',
  'rpc',
  'aborted',
])('retains complete holds for %s recovery', async (kind) => {
  const f = await fixture();
  const result = structuredClone(f.receipt.result);
  if (kind === 'failed') result.meta.err = { InstructionError: [1, 'Custom'] };
  if (kind === 'wrong-packet') result.transaction[0] = f.review.transaction;
  if (kind === 'wrong-slot') result.slot = 1;
  if (kind === 'wrong-tip')
    result.meta.postBalances[f.index(f.input.tipRecipient)] = '1000002001';
  if (kind === 'wrong-token')
    result.meta.postTokenBalances[1].uiTokenAmount.amount = '999999';
  if (kind === 'unexpected-native') {
    const index = f.index(f.roles.user_volume_accumulator),
      curve = f.index(f.roles.bonding_curve);
    result.meta.postBalances[index] = String(
      BigInt(result.meta.postBalances[index]) + 1n,
    );
    result.meta.postBalances[curve] = String(
      BigInt(result.meta.postBalances[curve]) - 1n,
    );
  }
  if (kind === 'wrong-inner')
    result.meta.innerInstructions[1].instructions[0].accounts[0] = 0;
  const rpc: VolumeRecoveryRpc = async (method) => {
    if (kind === 'rpc') throw Error('unavailable');
    return method === 'getGenesisHash'
      ? kind === 'network'
        ? 'devnet'
        : SOLANA_MAINNET_GENESIS
      : kind === 'missing'
        ? null
        : result;
  };
  const aborter = new AbortController();
  if (kind === 'aborted') aborter.abort();
  const run = () =>
    recoverVolumeBundleSettlement(
      f.db,
      'owner',
      f.request.id,
      rpc,
      aborter.signal,
    );
  if (kind === 'missing')
    expect(await run()).toMatchObject({
      state: 'unresolved',
      holdsRetained: true,
    });
  else await expect(run()).rejects.toThrow();
  expect(
    (await readVolumeBundleReservation(f.db, 'owner', f.request.id))?.state,
  ).toBe('attempted');
  expect(
    await readVolumeBundleTipBudget(f.db, 'owner', f.saved.id),
  ).toMatchObject({ heldLamports: '100000', spentLamports: '0' });
  expect(
    await readVolumeSettlementRecovery(f.db, 'owner', f.request.id),
  ).toBeNull();
});
it('rejects a direct SQL failure record with a missing error field instead of treating SQL NULL as approval', async () => {
  const f = await fixture();
  const receipt = structuredClone(f.receipt);
  receipt.result.meta.err = { InstructionError: [1, { Custom: 6002 }] };
  receipt.result.meta.postBalances = [...receipt.result.meta.preBalances];
  receipt.result.meta.postBalances[0] = String(
    BigInt(receipt.result.meta.preBalances[0]) - 5000n,
  );
  const proof = await verifyVolumePumpSettlement(f.review, f.route, receipt);
  delete (receipt.result.meta as { err?: unknown }).err;
  const reservation = await readVolumeBundleReservation(
    f.db,
    'owner',
    f.request.id,
  );
  const terms = {
    format: 'volume-settlement-recovery-v1',
    reservationId: f.request.id,
    attemptId: f.attempt,
    runtimeSha256: reservation!.runtimeSha256,
    proof,
    receipt,
    signingAllowed: false,
    executionAllowed: false,
    historicalCodeAttested: false,
  };
  const sha256 = await volumeDigest(terms);
  await expect(
    f.db
      .prepare(`INSERT INTO volume_bundle_settlements(reservation_id,owner_id,signature,document,sha256,tip_spent,created_at)
    VALUES(?,'owner',?,?,?,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(
        f.request.id,
        receipt.signature,
        JSON.stringify({ ...terms, sha256 }),
        sha256,
      )
      .run(),
  ).rejects.toThrow(/Verified bound/);
  expect(
    (await readVolumeBundleReservation(f.db, 'owner', f.request.id))?.state,
  ).toBe('attempted');
});
it('rejects other owners, wrong attempt identity, invalid signatures and direct terminal updates', async () => {
  const f = await fixture();
  await expect(
    bindVolumeRecoveryPacket(f.db, 'other', f.request.id, f.attempt, f.packet),
  ).rejects.toThrow();
  await expect(
    bindVolumeRecoveryPacket(
      f.db,
      'owner',
      f.request.id,
      crypto.randomUUID(),
      f.packet,
    ),
  ).rejects.toThrow();
  await expect(
    bindVolumeRecoveryPacket(
      f.db,
      'owner',
      f.request.id,
      f.attempt,
      f.review.transaction,
    ),
  ).rejects.toThrow();
  await expect(
    recoverVolumeBundleSettlement(
      f.db,
      'other',
      f.request.id,
      f.rpc,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  await expect(
    f.client.execute("UPDATE volume_bundle_reservations SET state='settled'"),
  ).rejects.toThrow();
});
it('cancels an uncooperative receipt lookup without persisting a settlement or releasing holds', async () => {
  const f = await fixture();
  const controller = new AbortController();
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const rpc: VolumeRecoveryRpc = async (method) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    started();
    return new Promise(() => {});
  };
  const pending = recoverVolumeBundleSettlement(
    f.db,
    'owner',
    f.request.id,
    rpc,
    controller.signal,
  );
  await waiting;
  controller.abort();
  await expect(pending).rejects.toThrow(/cancelled/);
  expect(
    (await readVolumeBundleReservation(f.db, 'owner', f.request.id))?.state,
  ).toBe('attempted');
  expect(
    await readVolumeSettlementRecovery(f.db, 'owner', f.request.id),
  ).toBeNull();
});
it('recovers a finalized fee-only failure, records zero volume/tip and closes the round without retrying', async () => {
  const f = await fixture();
  const result = structuredClone(f.receipt.result);
  result.meta.err = { InstructionError: [1, { Custom: 6002 }] };
  result.meta.postBalances = [...result.meta.preBalances];
  result.meta.postBalances[0] = String(
    BigInt(result.meta.preBalances[0]) - 5000n,
  );
  result.meta.innerInstructions = [];
  // A concurrent incoming token balance is untouched by the failed transaction.
  result.meta.preTokenBalances[0].uiTokenAmount.amount = '12';
  result.meta.postTokenBalances[0].uiTokenAmount.amount = '12';
  const rpc: VolumeRecoveryRpc = async (method) =>
    method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : result;
  const recovered = await recoverVolumeBundleSettlement(
    f.db,
    'owner',
    f.request.id,
    rpc,
    new AbortController().signal,
  );
  expect(recovered).toMatchObject({
    proof: {
      outcome: 'failed',
      atomicRollbackVerified: true,
      feeLamports: '5000',
      tipLamports: '0',
      actualVolumeLamports: '0',
      netLamports: '-5000',
    },
  });
  expect(
    (await readVolumeBundleReservation(f.db, 'owner', f.request.id))?.state,
  ).toBe('settled');
  expect(
    await readVolumeBundleTipBudget(f.db, 'owner', f.saved.id),
  ).toMatchObject({
    heldLamports: '0',
    spentLamports: '0',
    availableLamports: '1000000',
  });
  expect(
    await readVolumeSettlementRecovery(f.db, 'owner', f.request.id),
  ).toEqual(recovered);
  await expect(
    reserveVolumeBundleRound(
      f.db,
      'owner',
      { ...f.request, id: crypto.randomUUID() },
      f.deps,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/UNIQUE/);
});
it.each([
  'payer',
  'other-account',
  'tokens',
  'instruction-index',
  'missing-error',
])(
  'retains an attempted hold for an incomplete %s failure rollback',
  async (kind) => {
    const f = await fixture();
    const result = structuredClone(f.receipt.result);
    result.meta.err = { InstructionError: [1, { Custom: 6002 }] };
    result.meta.postBalances = [...result.meta.preBalances];
    result.meta.postBalances[0] = String(
      BigInt(result.meta.preBalances[0]) - 5000n,
    );
    if (kind === 'payer')
      result.meta.postBalances[0] = String(
        BigInt(result.meta.postBalances[0]) - 1n,
      );
    if (kind === 'other-account') {
      result.meta.postBalances[f.index(f.roles.bonding_curve)] = String(
        BigInt(result.meta.postBalances[f.index(f.roles.bonding_curve)]) - 1n,
      );
      result.meta.postBalances[f.index(f.roles.creator_vault)] = String(
        BigInt(result.meta.postBalances[f.index(f.roles.creator_vault)]) + 1n,
      );
    }
    if (kind === 'tokens')
      result.meta.postTokenBalances[0].uiTokenAmount.amount = '1';
    if (kind === 'instruction-index')
      result.meta.err = { InstructionError: [3, { Custom: 6002 }] };
    if (kind === 'missing-error') result.meta.err = undefined;
    const rpc: VolumeRecoveryRpc = async (method) =>
      method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : result;
    await expect(
      recoverVolumeBundleSettlement(
        f.db,
        'owner',
        f.request.id,
        rpc,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(
      (await readVolumeBundleReservation(f.db, 'owner', f.request.id))?.state,
    ).toBe('attempted');
  },
);
