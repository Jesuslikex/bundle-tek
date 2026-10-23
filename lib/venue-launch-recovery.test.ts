import { afterEach, describe, expect, it, vi } from 'vitest';
import { venueRecoveryFixture } from '../test/venue-launch-recovery-fixture';
import {
  actVenueLaunchRecovery as act,
  prepareVenueLaunchRecovery as prepare,
  readVenueLaunchRecovery as read,
  listVenueLaunchRecoveries as list,
} from './venue-launch-recovery';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { MeteoraDbcReview } from './meteora-dbc-launch-service';
import type { StonkLaunchReview } from './stonkfun-launch-service';

const signal = () => new AbortController().signal;
type Fixture = Awaited<ReturnType<typeof venueRecoveryFixture>>;
const kept: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of kept) f.dispose();
  kept.length = 0;
});
async function fixture(venue: Fixture['venue']) {
  const f = await venueRecoveryFixture(venue);
  kept.push(f);
  return f;
}
async function saved(f: Fixture) {
  return await prepare(f.db, f.owner, f.venue, f.terms, signal(), f.deps);
}
async function approved(f: Fixture) {
  const p = await saved(f);
  await act(
    f.db,
    f.owner,
    f.venue,
    { action: 'approve', id: p.recoveryId, sha256: p.sha256, approved: true },
    signal(),
    f.deps,
  );
  return p;
}
async function signed(f: Fixture) {
  const p = await approved(f);
  await act(
    f.db,
    f.owner,
    f.venue,
    { action: 'register', id: p.recoveryId, transaction: f.signed },
    signal(),
    f.deps,
  );
  return p;
}
const sends = (f: Fixture) =>
  f.rpc.mock.calls.filter(([m]) => m === 'sendTransaction');
for (const venue of ['meteora-dbc', 'stonkfun'] as const)
  it(`${venue}: malformed signature registration is a deterministic 400 without sending`, async () => {
    const f = await fixture(venue);
    const p = await approved(f);
    await expect(
      act(
        f.db,
        f.owner,
        venue,
        {
          action: 'register',
          id: p.recoveryId,
          transaction: 'not-a-signed-packet',
        },
        signal(),
        f.deps,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(sends(f)).toHaveLength(0);
    expect(await read(f.db, f.owner, venue, p.recoveryId)).toMatchObject({
      state: 'approved',
    });
  });
function submit(f: Fixture, p: Awaited<ReturnType<typeof saved>>) {
  return act(
    f.db,
    f.owner,
    f.venue,
    { action: 'submit', id: p.recoveryId, sha256: p.sha256, approved: true },
    signal(),
    f.deps,
  );
}

describe.each(['meteora-dbc', 'stonkfun'] as const)(
  '%s durable native recovery',
  (venue) => {
    it('keeps the original ID when identical terms arrive in another key order', async () => {
      const f = await fixture(venue),
        p = await saved(f);
      const reversed = Object.fromEntries(
        Object.entries(f.terms).reverse(),
      ) as typeof f.terms;
      expect(
        await prepare(f.db, f.owner, venue, reversed, signal(), f.deps),
      ).toEqual(p);
      expect(f.rpc).not.toHaveBeenCalled();
    });
    it('refuses REPLACE with a fresh ID that would evict an unresolved signed record', async () => {
      const f = await fixture(venue),
        p = await signed(f);
      expect(
        f.sqlite.prepare('PRAGMA recursive_triggers').get()?.recursive_triggers,
      ).toBe(0);
      expect(() =>
        f.sqlite
          .prepare(`INSERT OR REPLACE INTO venue_launch_recoveries(id,owner_id,venue,project_id,payer,mint,project_document,terms,review,sha256,minimum_slot,state,signed,signature,receipt,created_at,expires_at)
        SELECT ?,owner_id,venue,project_id,payer,mint,project_document,terms,review,sha256,minimum_slot,'review',NULL,NULL,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),expires_at FROM venue_launch_recoveries WHERE id=?`)
          .run(crypto.randomUUID(), p.recoveryId),
      ).toThrow('unavailable or busy');
      expect((await read(f.db, f.owner, venue, p.recoveryId)).state).toBe(
        'signed',
      );
      expect(
        f.sqlite
          .prepare('SELECT count(*) AS n FROM venue_launch_recoveries')
          .get()?.n,
      ).toBe(1);
      expect(f.rpc).not.toHaveBeenCalled();
    });
    it('refuses project-document drift during preparation even when its timestamp is reused', async () => {
      const f = await fixture(venue);
      const drift = () =>
        f.sqlite
          .prepare('UPDATE workspace_projects SET document=?')
          .run('{"synthetic":"changed"}');
      if (venue === 'meteora-dbc')
        vi.mocked(f.deps.prepareDbc!).mockImplementationOnce(async () => {
          drift();
          return structuredClone(f.review) as MeteoraDbcReview;
        });
      else
        vi.mocked(f.deps.prepareStonk!).mockImplementationOnce(async () => {
          drift();
          return structuredClone(f.review) as StonkLaunchReview;
        });
      await expect(saved(f)).rejects.toThrow('Launch source changed');
      expect(
        (await list(f.db, f.owner, venue, f.review.terms.projectId)).launches,
      ).toEqual([]);
      expect(f.rpc).not.toHaveBeenCalled();
    });
    it('persists the real builder review; exact prepare replay, list and owner/venue isolation are saved-only', async () => {
      const f = await fixture(venue),
        p = await saved(f);
      expect(await saved(f)).toEqual(p);
      expect((await read(f.db, f.owner, venue, p.recoveryId)).review).toEqual(
        f.review,
      );
      expect(
        (await list(f.db, f.owner, venue, f.review.terms.projectId)).launches,
      ).toHaveLength(1);
      expect(
        (await list(f.db, 'other', venue, f.review.terms.projectId)).launches,
      ).toEqual([]);
      await expect(
        read(f.db, 'other', venue, p.recoveryId),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        read(
          f.db,
          f.owner,
          venue === 'meteora-dbc' ? 'stonkfun' : 'meteora-dbc',
          p.recoveryId,
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(f.rpc).not.toHaveBeenCalled();
      expect(f.submit).not.toHaveBeenCalled();
      expect(
        venue === 'meteora-dbc' ? f.deps.prepareDbc : f.deps.prepareStonk,
      ).toHaveBeenCalledOnce();
    });
    it('requires exact separate approval and proof, then registers both authentic signatures without sending', async () => {
      const f = await fixture(venue),
        p = await saved(f);
      for (const body of [
        {
          action: 'approve',
          id: p.recoveryId,
          sha256: '0'.repeat(64),
          approved: true,
        },
        {
          action: 'approve',
          id: p.recoveryId,
          sha256: p.sha256,
          approved: false,
        },
        { action: 'register', id: p.recoveryId, transaction: f.signed },
      ])
        await expect(
          act(f.db, f.owner, venue, body, signal(), f.deps),
        ).rejects.toThrow();
      f.sqlite.prepare('DELETE FROM wallet_ownership_proofs').run();
      await expect(
        act(
          f.db,
          f.owner,
          venue,
          {
            action: 'approve',
            id: p.recoveryId,
            sha256: p.sha256,
            approved: true,
          },
          signal(),
          f.deps,
        ),
      ).rejects.toThrow();
      f.sqlite
        .prepare("INSERT INTO wallet_ownership_proofs VALUES(?,'Solana',?)")
        .run(f.owner, f.review.terms.payer);
      await act(
        f.db,
        f.owner,
        venue,
        {
          action: 'approve',
          id: p.recoveryId,
          sha256: p.sha256,
          approved: true,
        },
        signal(),
        f.deps,
      );
      const registered = await act(
        f.db,
        f.owner,
        venue,
        { action: 'register', id: p.recoveryId, transaction: f.signed },
        signal(),
        f.deps,
      );
      expect(registered).toMatchObject({
        state: 'signed',
        signature: f.signature,
        receipt: null,
      });
      expect(f.rpc).not.toHaveBeenCalled();
    });
    it('retains authentic expired signatures but refuses broadcast and never retries', async () => {
      const f = await fixture(venue),
        p = await approved(f);
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.review.expiresAt) + 1);
      expect(
        (
          await act(
            f.db,
            f.owner,
            venue,
            { action: 'register', id: p.recoveryId, transaction: f.signed },
            signal(),
            f.deps,
          )
        ).state,
      ).toBe('signed');
      await expect(submit(f, p)).rejects.toThrow(/expired/);
      expect((await read(f.db, f.owner, venue, p.recoveryId)).state).toBe(
        'signed',
      );
      expect(sends(f)).toHaveLength(0);
    });
    it('claims one durable send before the exact synthetic packet reaches the supplied RPC and never repeats it', async () => {
      const f = await fixture(venue),
        p = await signed(f);
      const results = await Promise.allSettled([submit(f, p), submit(f, p)]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      expect(sends(f)).toHaveLength(1);
      expect(sends(f)[0][1]).toEqual([
        f.signed,
        expect.objectContaining({ maxRetries: 0 }),
      ]);
      expect((await read(f.db, f.owner, venue, p.recoveryId)).state).toBe(
        'submitted',
      );
      await submit(f, p);
      expect(sends(f)).toHaveLength(1);
    });
    it('a committed send marker with a lost database reply invokes zero RPC sends and remains recoverable', async () => {
      const f = await fixture(venue),
        p = await signed(f);
      let lost = false;
      f.hooks.afterRun = (sql, values) => {
        if (
          !lost &&
          sql.startsWith('UPDATE venue_launch_recoveries SET state=') &&
          values[0] === 'submitting'
        ) {
          lost = true;
          throw Error('Synthetic lost marker reply');
        }
      };
      await expect(submit(f, p)).rejects.toThrow();
      expect((await read(f.db, f.owner, venue, p.recoveryId)).state).toBe(
        'submitting',
      );
      await submit(f, p);
      expect(sends(f)).toHaveLength(0);
    });
    it('an uncertain transport preserves the original signature and does not resend', async () => {
      const f = await fixture(venue),
        p = await signed(f);
      f.rpc.mockImplementation(async (method) => {
        if (method === 'sendTransaction')
          throw Error('Synthetic handoff uncertainty');
        return SOLANA_MAINNET_GENESIS;
      });
      expect((await submit(f, p)).state).toBe('submitting');
      expect(await read(f.db, f.owner, venue, p.recoveryId)).toMatchObject({
        state: 'submitting',
        signature: f.signature,
        receipt: null,
      });
      await submit(f, p);
      expect(sends(f)).toHaveLength(1);
    });
    it('project edits block approval and broadcasting while original saved recovery remains available', async () => {
      const f = await fixture(venue),
        p = await saved(f);
      f.sqlite.prepare("UPDATE workspace_projects SET document='{}'").run();
      await expect(
        act(
          f.db,
          f.owner,
          venue,
          {
            action: 'approve',
            id: p.recoveryId,
            sha256: p.sha256,
            approved: true,
          },
          signal(),
          f.deps,
        ),
      ).rejects.toThrow();
      f.sqlite
        .prepare(`UPDATE workspace_projects SET document='{"synthetic":true}'`)
        .run();
      await act(
        f.db,
        f.owner,
        venue,
        {
          action: 'approve',
          id: p.recoveryId,
          sha256: p.sha256,
          approved: true,
        },
        signal(),
        f.deps,
      );
      await act(
        f.db,
        f.owner,
        venue,
        { action: 'register', id: p.recoveryId, transaction: f.signed },
        signal(),
        f.deps,
      );
      f.sqlite.prepare("UPDATE workspace_projects SET document='{}'").run();
      await expect(submit(f, p)).rejects.toThrow();
      expect(sends(f)).toHaveLength(0);
      expect((await read(f.db, f.owner, venue, p.recoveryId)).review).toEqual(
        f.review,
      );
    });
    it.each([null, { InstructionError: [0, 'Custom'] }] as const)(
      'uses actual finalized recovery for exact signed bytes, including failed execution (%j)',
      async (err) => {
        const f = await fixture(venue),
          p = await signed(f);
        f.rpc.mockImplementation(async (method) =>
          method === 'getGenesisHash'
            ? SOLANA_MAINNET_GENESIS
            : method === 'getTransaction'
              ? {
                  slot: '100',
                  transaction: [f.signed, 'base64'],
                  meta: { err, fee: '5000' },
                }
              : Promise.reject(Error('Unexpected method')),
        );
        const result = await act(
          f.db,
          f.owner,
          venue,
          { action: 'recover', id: p.recoveryId },
          signal(),
          f.deps,
        );
        expect(result).toMatchObject({
          state: err === null ? 'finalized' : 'failed',
          receipt: {
            kind: 'finalized',
            signature: f.signature,
            mint: f.review.terms.mint,
            slot: '100',
            succeeded: err === null,
          },
        });
        const calls = f.rpc.mock.calls.length;
        await act(
          f.db,
          f.owner,
          venue,
          { action: 'recover', id: p.recoveryId },
          signal(),
          f.deps,
        );
        expect(f.rpc).toHaveBeenCalledTimes(calls);
        expect(sends(f)).toHaveLength(0);
      },
    );
    it.each(['packet', 'slot', 'genesis'] as const)(
      'refuses mismatched %s recovery evidence without terminalizing',
      async (mismatch) => {
        const f = await fixture(venue),
          p = await signed(f);
        f.rpc.mockImplementation(async (method) =>
          method === 'getGenesisHash'
            ? mismatch === 'genesis'
              ? 'wrong-network'
              : SOLANA_MAINNET_GENESIS
            : {
                slot: mismatch === 'slot' ? '99' : '100',
                transaction: [
                  mismatch === 'packet' ? f.review.transaction : f.signed,
                  'base64',
                ],
                meta: { err: null },
              },
        );
        await expect(
          act(
            f.db,
            f.owner,
            venue,
            { action: 'recover', id: p.recoveryId },
            signal(),
            f.deps,
          ),
        ).rejects.toThrow();
        expect((await read(f.db, f.owner, venue, p.recoveryId)).state).toBe(
          'signed',
        );
        expect(sends(f)).toHaveLength(0);
      },
    );
    it('requires finalized expiry beyond safety margin AND exact mint absence before cancelling an approved unsigned launch', async () => {
      const f = await fixture(venue),
        p = await approved(f);
      let height = '300000032',
        mint: unknown = null;
      f.rpc.mockImplementation(async (method) =>
        method === 'getGenesisHash'
          ? SOLANA_MAINNET_GENESIS
          : method === 'getEpochInfo'
            ? { absoluteSlot: '300000100', blockHeight: height }
            : { context: { slot: '300000100' }, value: mint },
      );
      const recover = () =>
        act(
          f.db,
          f.owner,
          venue,
          { action: 'cancel', id: p.recoveryId },
          signal(),
          f.deps,
        );
      expect((await recover()).state).toBe('approved');
      height = '300000033';
      mint = { owner: 'synthetic-existing-mint' };
      expect((await recover()).state).toBe('approved');
      mint = null;
      expect(await recover()).toMatchObject({
        state: 'cancelled',
        receipt: {
          kind: 'expired-unobserved',
          mintAbsent: true,
          signatureKnown: false,
        },
      });
      expect(sends(f)).toHaveLength(0);
    });
    it('lost prepare reply is discoverable by history; immutable SQL rejects tampering, deletion and replacement', async () => {
      const f = await fixture(venue);
      let lost = false;
      f.hooks.afterRun = (sql) => {
        if (!lost && sql.startsWith('INSERT INTO venue_launch_recoveries')) {
          lost = true;
          throw Error('Synthetic lost prepare reply');
        }
      };
      await expect(saved(f)).rejects.toThrow(/uncertain/);
      const history = await list(
        f.db,
        f.owner,
        venue,
        f.review.terms.projectId,
      );
      expect(history.launches).toHaveLength(1);
      const p = await saved(f);
      expect(p.recoveryId).toBe(history.launches[0].id);
      for (const sql of [
        "UPDATE venue_launch_recoveries SET review='{}'",
        'DELETE FROM venue_launch_recoveries',
        'INSERT OR REPLACE INTO venue_launch_recoveries SELECT * FROM venue_launch_recoveries',
      ])
        expect(() => f.sqlite.exec(sql)).toThrow();
      expect(
        (await list(f.db, f.owner, venue, f.review.terms.projectId)).launches,
      ).toHaveLength(1);
      expect(f.rpc).not.toHaveBeenCalled();
    });
  },
);
