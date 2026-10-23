import { afterEach, expect, it, vi } from 'vitest';
import { venueRecoveryFixture } from '../test/venue-launch-recovery-fixture';
import {
  actVenueLaunchRecovery as act,
  VenueLaunchPreparationNotSavedError,
  prepareVenueLaunchRecovery as prepare,
  readVenueLaunchRecovery as read,
  listVenueLaunchRecoveries as list,
} from './venue-launch-recovery';
const kept: Awaited<ReturnType<typeof venueRecoveryFixture>>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of kept.splice(0)) f.dispose();
});
const signal = () => new AbortController().signal;
for (const venue of ['LetsBonk', 'Surge'] as const) {
  async function setup() {
    const f = await venueRecoveryFixture('launchlab', venue);
    kept.push(f);
    const prepared = await prepare(
      f.db,
      f.owner,
      'launchlab',
      f.terms,
      signal(),
      f.deps,
    );
    const approve = () =>
      act(
        f.db,
        f.owner,
        'launchlab',
        {
          action: 'approve',
          id: prepared.recoveryId,
          sha256: prepared.sha256,
          approved: true,
        },
        signal(),
        f.deps,
      );
    const register = () =>
      act(
        f.db,
        f.owner,
        'launchlab',
        { action: 'register', id: prepared.recoveryId, transaction: f.signed },
        signal(),
        f.deps,
      );
    const submit = () =>
      act(
        f.db,
        f.owner,
        'launchlab',
        {
          action: 'submit',
          id: prepared.recoveryId,
          sha256: prepared.sha256,
          approved: true,
        },
        signal(),
        f.deps,
      );
    const recover = () =>
      act(
        f.db,
        f.owner,
        'launchlab',
        { action: 'recover', id: prepared.recoveryId },
        signal(),
        f.deps,
      );
    return { ...f, prepared, approve, register, submit, recover };
  }
  it(`${venue}: retains original review and owner history without renewing or making another provider request`, async () => {
    const f = await setup();
    const retry = await prepare(
      f.db,
      f.owner,
      'launchlab',
      Object.fromEntries(Object.entries(f.terms).reverse()) as typeof f.terms,
      signal(),
      f.deps,
    );
    expect(retry).toEqual(f.prepared);
    expect(f.deps.prepareLaunchLab).toHaveBeenCalledOnce();
    expect(
      (await list(f.db, f.owner, 'launchlab', f.terms.projectId)).launches,
    ).toHaveLength(1);
    await expect(
      read(f.db, 'other', 'launchlab', f.prepared.recoveryId),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it(`${venue}: needs exact approval and both authentic signatures before one send`, async () => {
    const f = await setup();
    await expect(f.register()).rejects.toThrow('Approve');
    await f.approve();
    await f.register();
    expect(f.rpc).not.toHaveBeenCalled();
    expect(await f.submit()).toMatchObject({
      state: 'submitted',
      signature: f.signature,
    });
    expect(await f.submit()).toMatchObject({ state: 'submitted' });
    expect(
      f.rpc.mock.calls.filter(([m]) => m === 'sendTransaction'),
    ).toHaveLength(1);
  });
  it(`${venue}: an unknown send stays recoverable and cannot broadcast again`, async () => {
    const f = await setup();
    await f.approve();
    await f.register();
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (...args) => {
      if (args[0] === 'sendTransaction') throw Error('Lost reply');
      return base(...args);
    });
    expect(await f.submit()).toMatchObject({
      state: 'submitting',
      signature: f.signature,
    });
    expect(await f.recover()).toMatchObject({ state: 'submitting' });
    await f.submit();
    expect(
      f.rpc.mock.calls.filter(([m]) => m === 'sendTransaction'),
    ).toHaveLength(1);
  });
  it(`${venue}: lost marker acknowledgement permits no send even if its SQL committed`, async () => {
    const f = await setup();
    await f.approve();
    await f.register();
    f.hooks.afterRun = (sql, values) => {
      if (
        sql.startsWith('UPDATE launchlab_launch_recoveries') &&
        values[0] === 'submitting'
      )
        throw Error('Lost marker reply');
    };
    await expect(f.submit()).rejects.toThrow();
    f.hooks.afterRun = undefined;
    expect(
      await read(f.db, f.owner, 'launchlab', f.prepared.recoveryId),
    ).toMatchObject({ state: 'submitting' });
    await f.submit();
    expect(
      f.rpc.mock.calls.filter(([m]) => m === 'sendTransaction'),
    ).toHaveLength(0);
  });
  it(`${venue}: saves an exact finalized receipt and keeps it available after parent archive`, async () => {
    const f = await setup();
    await f.approve();
    await f.register();
    await f.submit();
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (...args) =>
      args[0] === 'getTransaction'
        ? {
            slot: '101',
            transaction: [f.signed, 'base64'],
            meta: { err: null, fee: '5000' },
          }
        : base(...args),
    );
    expect(await f.recover()).toMatchObject({
      state: 'finalized',
      receipt: {
        kind: 'finalized',
        signature: f.signature,
        mint: f.terms.mint,
        succeeded: true,
      },
    });
    f.sqlite.prepare('UPDATE workspace_projects SET archived=1').run();
    expect(
      await read(f.db, f.owner, 'launchlab', f.prepared.recoveryId),
    ).toMatchObject({ state: 'finalized' });
  });
  it(`${venue}: same-timestamp document drift refuses approval without signing or sending`, async () => {
    const f = await setup();
    f.sqlite
      .prepare(
        "UPDATE workspace_projects SET document=json_set(document,'$.changed',1)",
      )
      .run();
    await expect(f.approve()).rejects.toThrow();
    expect(f.rpc).not.toHaveBeenCalled();
    expect(
      await read(f.db, f.owner, 'launchlab', f.prepared.recoveryId),
    ).toMatchObject({ state: 'review' });
  });
  it(`${venue}: signed rows cannot be replaced by a new active review with a fresh ID`, async () => {
    const f = await setup();
    await f.approve();
    await f.register();
    expect(() =>
      f.sqlite
        .prepare(`INSERT OR REPLACE INTO launchlab_launch_recoveries
      SELECT ?,owner_id,venue,project_id,payer,mint,project_document,terms,review,sha256,minimum_slot,'review',NULL,NULL,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),expires_at FROM launchlab_launch_recoveries`)
        .run(crypto.randomUUID()),
    ).toThrow();
    expect(
      await read(f.db, f.owner, 'launchlab', f.prepared.recoveryId),
    ).toMatchObject({ state: 'signed', signature: f.signature });
  });
  it(`${venue}: reciprocal old-venue and Pump payer guards preserve original reviews`, async () => {
    const f = await setup();
    const other = await venueRecoveryFixture('stonkfun');
    kept.push(other);
    expect(() =>
      f.sqlite
        .prepare(
          'INSERT INTO pump_launch_reviews(owner_id,payer,state) VALUES(?,?,?)',
        )
        .run(f.owner, f.terms.payer, 'prepared'),
    ).toThrow();
    const prepareOther = () =>
      prepare(f.db, f.owner, 'stonkfun', other.terms, signal(), other.deps);
    await expect(prepareOther()).rejects.toThrow();
    await act(
      f.db,
      f.owner,
      'launchlab',
      { action: 'cancel', id: f.prepared.recoveryId },
      signal(),
      f.deps,
    );
    const old = await prepareOther();
    await expect(
      prepare(f.db, f.owner, 'launchlab', f.terms, signal(), f.deps),
    ).rejects.toThrow();
    expect(await read(f.db, f.owner, 'stonkfun', old.recoveryId)).toMatchObject(
      { state: 'review' },
    );
  });
  it(`${venue}: null or omitted venue cannot pass the SQL admission rule`, async () => {
    const f = await setup();
    await act(
      f.db,
      f.owner,
      'launchlab',
      { action: 'cancel', id: f.prepared.recoveryId },
      signal(),
      f.deps,
    );
    f.sqlite
      .prepare(
        "UPDATE workspace_projects SET document=json_remove(document,'$.plan.launchpad')",
      )
      .run();
    expect(() =>
      f.sqlite
        .prepare(`INSERT INTO launchlab_launch_recoveries
      SELECT ?,owner_id,venue,project_id,payer,mint,json_remove(project_document,'$.plan.launchpad'),json_remove(terms,'$.venue'),json_remove(review,'$.terms.venue','$.input.venue','$.summary.venue'),sha256,minimum_slot,'review',NULL,NULL,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),expires_at FROM launchlab_launch_recoveries`)
        .run(crypto.randomUUID()),
    ).toThrow();
  });
  it(`${venue}: reused mint or owned project conflicts with Pump even when the payer changes`, async () => {
    const f = await setup();
    expect(() =>
      f.sqlite
        .prepare('INSERT INTO pump_launch_reviews VALUES(?,?,?,?,?)')
        .run(
          'different-owner',
          'different-payer',
          'prepared',
          'different-project',
          f.terms.mint,
        ),
    ).toThrow();
    expect(() =>
      f.sqlite
        .prepare('INSERT INTO pump_launch_reviews VALUES(?,?,?,?,?)')
        .run(
          f.owner,
          'different-payer',
          'prepared',
          f.terms.projectId,
          'different-mint',
        ),
    ).toThrow();
    await act(
      f.db,
      f.owner,
      'launchlab',
      { action: 'cancel', id: f.prepared.recoveryId },
      signal(),
      f.deps,
    );
    f.sqlite
      .prepare('INSERT INTO pump_launch_reviews VALUES(?,?,?,?,?)')
      .run(
        'different-owner',
        'different-payer',
        'finalized',
        'different-project',
        f.terms.mint,
      );
    await expect(
      prepare(f.db, f.owner, 'launchlab', f.terms, signal(), f.deps),
    ).rejects.toThrow();
  });
  it(`${venue}: an adapter cannot use another RPC method to bypass the send marker`, async () => {
    const f = await setup();
    await f.approve();
    await f.register();
    f.deps.submitLaunchLab = async (...args) => {
      await args[6]!.rpc!('sendBundle', [], args[5]);
      throw Error('Must not reach transport');
    };
    await expect(f.submit()).rejects.toThrow(
      'Unsupported launch submission transport',
    );
    expect(f.rpc).not.toHaveBeenCalled();
    expect(
      await read(f.db, f.owner, 'launchlab', f.prepared.recoveryId),
    ).toMatchObject({ state: 'signed' });
  });
}

for (const venue of ['LetsBonk', 'Surge'] as const)
  for (const reason of ['slot', 'source']) {
    it(
      venue +
        ': only a pre-insert ' +
        reason +
        ' refusal carries definite-not-saved provenance',
      async () => {
        const f = await venueRecoveryFixture('launchlab', venue);
        kept.push(f);
        const original = f.deps.prepareLaunchLab!;
        f.deps.prepareLaunchLab = async (...args) => {
          const review = await original(...args);
          if (reason === 'slot') return { ...review, minimumSlot: undefined };
          f.sqlite
            .prepare('UPDATE workspace_projects SET document=?')
            .run('{"changed":true}');
          return review;
        };
        await expect(
          prepare(f.db, f.owner, 'launchlab', f.terms, signal(), f.deps),
        ).rejects.toBeInstanceOf(VenueLaunchPreparationNotSavedError);
        expect(
          (await list(f.db, f.owner, 'launchlab', f.terms.projectId)).launches,
        ).toEqual([]);
        expect(f.rpc).not.toHaveBeenCalled();
      },
    );
  }
