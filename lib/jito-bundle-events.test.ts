import { readFileSync } from 'node:fs';
import { bundleFingerprint } from './jito-bundle';
import { expect, it } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { jitoDatabase } from '../test/jito-sqlite';
import { registerJitoPacket, cancelJitoBundle } from './jito-bundle-server';
import {
  recordJitoBaselines,
  jitoBaselinePending,
} from './jito-bundle-baseline';
import {
  isJitoBundleEvent,
  jitoEventMatchesManifest,
  jitoBundleEventDetail,
  jitoBundleEventLabel,
  type JitoBundleEvent,
} from './jito-bundle-events';
function events(d: ReturnType<typeof jitoDatabase>) {
  return d.sqlite
    .prepare(
      'SELECT id,sequence,bundle_id AS bundleId,project_id AS projectId,session_id AS sessionId,type,packet,document,created_at AS createdAt FROM jito_bundle_events ORDER BY sequence',
    )
    .all()
    .map((r) => ({
      ...r,
      document: JSON.parse(String(r.document)),
    })) as JitoBundleEvent[];
}
it('atomically captures exact packet registration once and retains submission-state transitions', async () => {
  const f = await jitoBundleFixture(),
    d = jitoDatabase(f.manifest);
  d.attach();
  try {
    await registerJitoPacket(
      d.db,
      'owner',
      f.manifest.id,
      f.manifest.sha256,
      0,
      f.swap.signed.transaction,
    );
    await registerJitoPacket(
      d.db,
      'owner',
      f.manifest.id,
      f.manifest.sha256,
      0,
      f.swap.signed.transaction,
    );
    await registerJitoPacket(
      d.db,
      'owner',
      f.manifest.id,
      f.manifest.sha256,
      1,
      f.tip.signed.transaction,
    );
    let history = events(d);
    expect(history.map((e) => e.type)).toEqual([
      'bundle.reviewed',
      'packet.registered',
      'packet.registered',
    ]);
    expect(history.map((e) => e.document.signedCount)).toEqual([0, 1, 2]);
    expect(history.map((e) => e.packet)).toEqual([null, 0, 1]);
    expect(history.every(isJitoBundleEvent)).toBe(true);
    expect(history.every((e) => jitoEventMatchesManifest(e, f.manifest))).toBe(
      true,
    );
    const captured = history[1];
    for (const altered of [
      { ...f.manifest, id: crypto.randomUUID() },
      { ...f.manifest, projectId: crypto.randomUUID() },
      { ...f.manifest, sessionId: crypto.randomUUID() },
      { ...f.manifest, sessionRevision: f.manifest.sessionRevision + 1 },
      { ...f.manifest, sha256: '00'.repeat(32) },
      { ...f.manifest, createdAt: '2020-01-01T00:00:00Z' },
      { ...f.manifest, tip: { ...f.manifest.tip, amountRaw: '2000' } },
      { ...f.manifest, swaps: [] },
    ])
      expect(jitoEventMatchesManifest(captured, altered)).toBe(false);
    expect(JSON.stringify(history)).not.toContain(f.swap.signed.transaction);
    expect(JSON.stringify(history)).not.toContain(f.swap.signed.signature);
    expect(jitoBundleEventLabel(history[1])).toContain(
      'packet 1 signature registered',
    );
    expect(jitoBundleEventDetail(history[1])).toContain(
      'do not establish submission',
    );
    await expect(
      registerJitoPacket(
        d.db,
        'owner',
        f.manifest.id,
        f.manifest.sha256,
        0,
        f.tip.signed.transaction,
      ),
    ).rejects.toThrow();
    expect(events(d)).toHaveLength(3);
    const now = new Date().toISOString();
    d.sqlite
      .prepare(
        "UPDATE jito_bundles SET state='submitting',updated_at=? WHERE id=?",
      )
      .run(now, f.manifest.id);
    d.sqlite
      .prepare(
        "UPDATE jito_bundles SET state='submitted',bundle_id=?,updated_at=? WHERE id=?",
      )
      .run('ab'.repeat(32), now, f.manifest.id);
    d.sqlite
      .prepare(
        "UPDATE jito_bundles SET state='finalized',updated_at=? WHERE id=?",
      )
      .run(now, f.manifest.id);
    history = events(d);
    expect(history.slice(-3).map((e) => e.type)).toEqual([
      'bundle.submitting',
      'bundle.submitted',
      'bundle.finalized',
    ]);
    expect(history.every(isJitoBundleEvent)).toBe(true);
    expect(jitoBundleEventLabel(history.at(-3)!)).toContain('uncertain');
    expect(() =>
      d.sqlite
        .prepare("UPDATE jito_bundle_events SET type='bundle.finalized'")
        .run(),
    ).toThrow('immutable');
    expect(() =>
      d.sqlite.prepare('DELETE FROM jito_bundle_events').run(),
    ).toThrow('retained');
    expect(isJitoBundleEvent({ ...history[1], packet: 5 })).toBe(false);
    expect(
      isJitoBundleEvent({ ...history[1], projectId: crypto.randomUUID() }),
    ).toBe(false);
  } finally {
    d.sqlite.close();
  }
});
it('backfills one labelled retained-state baseline without inventing prior transitions', async () => {
  const f = await jitoBundleFixture(),
    d = jitoDatabase(f.manifest, false);
  d.attach();
  try {
    await cancelJitoBundle(d.db, 'owner', f.manifest.id);
    d.sqlite.exec(readFileSync('drizzle/0069_amusing_viper.sql', 'utf8'));
    expect(events(d)).toHaveLength(0);
    expect(await jitoBaselinePending(d.db, 'owner')).toBe(true);
    expect(await recordJitoBaselines(d.db, 'other')).toEqual({
      created: 0,
      baselinePending: false,
    });
    expect(await recordJitoBaselines(d.db, 'owner')).toEqual({
      created: 1,
      baselinePending: false,
    });
    expect(await recordJitoBaselines(d.db, 'owner')).toEqual({
      created: 0,
      baselinePending: false,
    });
    const history = events(d);
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe('bundle.baseline');
    expect(history[0].document.state).toBe('cancelled');
    expect(isJitoBundleEvent(history[0])).toBe(true);
    expect(jitoBundleEventDetail(history[0])).toContain(
      'prior transitions were not reconstructed',
    );
    expect(jitoBundleEventLabel(history[0])).toBe('Retained Jito bundle state');
  } finally {
    d.sqlite.close();
  }
});
it('bounds baseline batches to fifty and leaves newly tracked bundles unchanged', async () => {
  const f = await jitoBundleFixture(),
    d = jitoDatabase(f.manifest, false);
  d.attach();
  try {
    await cancelJitoBundle(d.db, 'owner', f.manifest.id);
    for (let i = 0; i < 55; i++) {
      const review = {
        ...f.manifest.swaps[0],
        id: crypto.randomUUID(),
        preparationId: crypto.randomUUID(),
      };
      const { sha256: _hash, ...terms } = {
        ...f.manifest,
        id: crypto.randomUUID(),
        swaps: [review],
      };
      const m = { ...terms, sha256: await bundleFingerprint(terms) };
      d.sqlite
        .prepare(
          'INSERT INTO imported_swap_preparations SELECT ?,owner_id,project_id,project_revision,wallet_revision,wallet_address,document,created_at FROM imported_swap_preparations WHERE id=?',
        )
        .run(review.preparationId, f.manifest.swaps[0].preparationId);
      d.sqlite
        .prepare(
          "INSERT INTO imported_swap_signing_intents SELECT ?,owner_id,?,wallet_address,?,'awaiting_signature',NULL,created_at,updated_at FROM imported_swap_signing_intents WHERE id=?",
        )
        .run(
          review.id,
          review.preparationId,
          JSON.stringify(review),
          f.manifest.swaps[0].id,
        );
      d.sqlite
        .prepare(
          "INSERT INTO jito_bundles VALUES(?,?,?,?,?,'reviewed',NULL,?,?)",
        )
        .run(
          'owner',
          m.id,
          m.projectId,
          m.sessionId,
          JSON.stringify(m),
          m.createdAt,
          m.createdAt,
        );
      for (let p = 0; p < 2; p++)
        d.sqlite
          .prepare('INSERT INTO jito_bundle_packets VALUES(?,?,?,?,NULL,NULL)')
          .run('owner', m.id, p, p === 0 ? review.id : null);
      await cancelJitoBundle(d.db, 'owner', m.id);
    }
    d.sqlite.exec(readFileSync('drizzle/0069_amusing_viper.sql', 'utf8'));
    expect(events(d)).toHaveLength(0);
    expect(await recordJitoBaselines(d.db, 'owner')).toEqual({
      created: 50,
      baselinePending: true,
    });
    expect(await recordJitoBaselines(d.db, 'owner')).toEqual({
      created: 6,
      baselinePending: false,
    });
    expect(await recordJitoBaselines(d.db, 'owner')).toEqual({
      created: 0,
      baselinePending: false,
    });
    expect(events(d)).toHaveLength(56);
    expect(events(d).every(isJitoBundleEvent)).toBe(true);
  } finally {
    d.sqlite.close();
  }
  const fresh = jitoDatabase(f.manifest);
  fresh.attach();
  try {
    expect(await recordJitoBaselines(fresh.db, 'owner')).toEqual({
      created: 0,
      baselinePending: false,
    });
    expect(events(fresh)).toHaveLength(1);
  } finally {
    fresh.sqlite.close();
  }
});
