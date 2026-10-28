import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import type { JitoBundleRecord } from './jito-bundle';
import { bundleFingerprint } from './jito-bundle';
import type { JitoAttempt } from './jito-sign-attempt-client';

// This tests journal state/crypto with a fault-injectable transaction double.
// It is not a substitute for a real-browser IndexedDB/Web Locks integration run.
const mock = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  fault: '',
  beforeInsert: undefined as undefined | (() => Promise<void>),
  beforeRetain: undefined as undefined | (() => Promise<void>),
  beforeDelete: undefined as undefined | (() => Promise<void>),
}));
vi.mock('./jito-recovery-journal-store', () => ({
  readJournalEntry: async (key: string) => structuredClone(mock.rows.get(key)),
  listJournalEntries: async () => {
    if (mock.rows.size > 100) throw Error('capacity');
    return structuredClone([...mock.rows.values()]);
  },
  deleteRetainedJournalEntry: async (expected: {
    key: string;
    state: string;
  }) => {
    if (mock.beforeDelete) await mock.beforeDelete();
    if (
      mock.fault === 'delete-before' ||
      expected.state !== 'retained' ||
      JSON.stringify(mock.rows.get(expected.key)) !== JSON.stringify(expected)
    )
      throw Error('delete failed');
    mock.rows.delete(expected.key);
    if (mock.fault === 'delete-after') throw Error('ambiguous delete');
  },
  insertJournalUnknown: async (value: { key: string }) => {
    if (mock.beforeInsert) await mock.beforeInsert();
    if (mock.fault === 'insert-before') throw Error('simulated failure');
    if (mock.rows.has(value.key) || mock.rows.size >= 100)
      throw Error('duplicate');
    mock.rows.set(value.key, structuredClone(value));
    if (mock.fault === 'insert-after') throw Error('ambiguous commit');
  },
  retainJournalEntry: async (expected: { key: string }, value: unknown) => {
    if (mock.beforeRetain) await mock.beforeRetain();
    if (mock.fault === 'cas-before') throw Error('simulated failure');
    if (
      JSON.stringify(mock.rows.get(expected.key)) !== JSON.stringify(expected)
    )
      throw Error('compare failed');
    mock.rows.set(expected.key, structuredClone(value));
    if (mock.fault === 'cas-after') throw Error('ambiguous commit');
  },
}));
import {
  acknowledgeJitoRecoveryRegistered,
  inspectJitoRecoveryJournal,
  listJitoRecoveryJournalPending,
  resumeJitoRecoveryUnknown,
  reserveJitoRecoveryUnknown,
  reserveJitoImportedEvidence,
  retainJitoRecoverySignature,
  withJitoRecoveryJournalLock,
  type JitoJournalLock,
} from './jito-recovery-journal';

const alice = 'a'.repeat(64);
const password = 'ordinary vault password';
const occupied = new Set<string>();
beforeEach(() => {
  mock.rows.clear();
  mock.fault = '';
  mock.beforeInsert = undefined;
  mock.beforeRetain = undefined;
  mock.beforeDelete = undefined;
  occupied.clear();
  vi.stubGlobal('navigator', {
    locks: {
      request: async (
        name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<unknown>,
      ) => {
        if (occupied.has(name)) return callback(null);
        occupied.add(name);
        try {
          return await callback({ name });
        } finally {
          occupied.delete(name);
        }
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture() {
  const f = await jitoBundleFixture();
  const record: JitoBundleRecord = {
    manifest: f.manifest,
    state: 'reviewed',
    bundleId: null,
    signatures: Array(f.manifest.swaps.length + 1).fill(null),
    updatedAt: f.manifest.createdAt,
  };
  const fresh = async () => ({
    ownerScope: alice,
    record: structuredClone(record),
  });
  return { ...f, record, fresh };
}
const guard = () => {};

function importedAttempt(
  f: Awaited<ReturnType<typeof fixture>>,
  packet = 0,
): JitoAttempt {
  return {
    bundleId: f.manifest.id,
    manifestSha256: f.manifest.sha256,
    packet,
    attemptId: '11111111-1111-4111-8111-111111111111',
    signer: f.manifest.swaps[packet]?.wallet ?? f.manifest.tip.wallet,
    intentId: f.manifest.swaps[packet]?.id ?? null,
    state: 'unknown',
    signature: null,
    transaction: null,
  };
}

describe('imported signed evidence reservation', () => {
  it('binds a tip evidence import to its null intent and tip payer', async () => {
    const f = await fixture(),
      attempt = importedAttempt(f, 1);
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      const reservation = await reserveJitoImportedEvidence(
        token,
        f.manifest,
        1,
        password,
        f.tip.signed.transaction,
        attempt.attemptId,
        async () => ({ ownerScope: alice, record: f.record, attempt }),
      );
      await retainJitoRecoverySignature(
        token,
        reservation,
        f.manifest,
        f.tip.signed.transaction,
      );
      expect(
        (
          await inspectJitoRecoveryJournal(
            token,
            f.manifest,
            1,
            password,
            f.fresh,
          )
        ).status,
      ).toBe('retained');
    });
  });
  it('rejects a callback result mutated before the awaited response is owned', async () => {
    const f = await fixture(),
      attempt = importedAttempt(f);
    const shared = {
      ownerScope: alice,
      record: f.record,
      attempt: { ...attempt },
    };
    await expect(
      withJitoRecoveryJournalLock(alice, guard, (token) =>
        reserveJitoImportedEvidence(
          token,
          f.manifest,
          0,
          password,
          f.swap.signed.transaction,
          attempt.attemptId,
          async () => {
            queueMicrotask(() => {
              shared.attempt.signer = f.tip.recipient;
            });
            return shared;
          },
        ),
      ),
    ).rejects.toThrow();
    expect(mock.rows.size).toBe(0);
  });
  it('accepts a verified expired packet for an exact existing UNKNOWN without authorizing signing', async () => {
    const f = await fixture();
    const { sha256: _old, ...terms } = f.manifest;
    terms.expiresAt = new Date(Date.now() - 1000).toISOString();
    f.manifest = { ...terms, sha256: await bundleFingerprint(terms) };
    f.record.manifest = f.manifest;
    const attempt = importedAttempt(f);
    const read = async () => ({
      ownerScope: alice,
      record: structuredClone(f.record),
      attempt: structuredClone(attempt),
    });
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      const reservation = await reserveJitoImportedEvidence(
        token,
        f.manifest,
        0,
        password,
        f.swap.signed.transaction,
        attempt.attemptId,
        read,
      );
      await retainJitoRecoverySignature(
        token,
        reservation,
        f.manifest,
        f.swap.signed.transaction,
      );
      expect(
        (
          await inspectJitoRecoveryJournal(
            token,
            f.manifest,
            0,
            password,
            f.fresh,
          )
        ).status,
      ).toBe('retained');
    });
    expect(mock.rows.size).toBe(1);
  });
  it('refuses wrong nonce, identity, absent attempt, registered state and different packet before writing', async () => {
    const f = await fixture(),
      original = importedAttempt(f);
    const cases = [
      { ...original, attemptId: '22222222-2222-4222-8222-222222222222' },
      { ...original, signer: f.tip.recipient },
      { ...original, intentId: null },
      { ...original, bundleId: crypto.randomUUID() },
      { ...original, manifestSha256: 'ff'.repeat(32) },
      { ...original, packet: 1 },
      { ...original, state: 'registered' },
      null,
    ];
    for (const attempt of cases) {
      await expect(
        withJitoRecoveryJournalLock(alice, guard, (token) =>
          reserveJitoImportedEvidence(
            token,
            f.manifest,
            0,
            password,
            f.swap.signed.transaction,
            original.attemptId,
            async () => ({
              ownerScope: alice,
              record: f.record,
              attempt: attempt as JitoAttempt,
            }),
          ),
        ),
      ).rejects.toThrow();
      expect(mock.rows.size).toBe(0);
    }
    await expect(
      withJitoRecoveryJournalLock(alice, guard, (token) =>
        reserveJitoImportedEvidence(
          token,
          f.manifest,
          0,
          password,
          f.tip.signed.transaction,
          original.attemptId,
          async () => ({
            ownerScope: alice,
            record: f.record,
            attempt: original,
          }),
        ),
      ),
    ).rejects.toThrow();
    expect(mock.rows.size).toBe(0);
  });
  it.each(['insert-before', 'insert-after'])(
    'fails closed for %s and preserves any ambiguous marker',
    async (fault) => {
      const f = await fixture(),
        attempt = importedAttempt(f);
      mock.fault = fault;
      await expect(
        withJitoRecoveryJournalLock(alice, guard, (token) =>
          reserveJitoImportedEvidence(
            token,
            f.manifest,
            0,
            password,
            f.swap.signed.transaction,
            attempt.attemptId,
            async () => ({ ownerScope: alice, record: f.record, attempt }),
          ),
        ),
      ).rejects.toThrow();
      expect(mock.rows.size).toBe(fault === 'insert-after' ? 1 : 0);
      if (fault === 'insert-after')
        expect([...mock.rows.values()][0]).toMatchObject({ state: 'unknown' });
    },
  );
  it.each(['unknown', 'retained'])(
    'never overwrites an existing %s entry',
    async (state) => {
      const f = await fixture(),
        attempt = importedAttempt(f);
      await withJitoRecoveryJournalLock(alice, guard, async (token) => {
        const reserved = await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
        if (state === 'retained')
          await retainJitoRecoverySignature(
            token,
            reserved,
            f.manifest,
            f.swap.signed.transaction,
          );
      });
      const before = structuredClone([...mock.rows.values()][0]);
      await expect(
        withJitoRecoveryJournalLock(alice, guard, (token) =>
          reserveJitoImportedEvidence(
            token,
            f.manifest,
            0,
            password,
            f.swap.signed.transaction,
            attempt.attemptId,
            async () => ({ ownerScope: alice, record: f.record, attempt }),
          ),
        ),
      ).rejects.toThrow();
      expect([...mock.rows.values()][0]).toEqual(before);
    },
  );
  it.each(['owner', 'attempt', 'registered'])(
    'retains UNKNOWN if %s changes during the insert',
    async (changed) => {
      const f = await fixture(),
        attempt = importedAttempt(f);
      const response = {
        ownerScope: alice,
        record: f.record,
        attempt: { ...attempt },
      };
      mock.beforeInsert = async () => {
        if (changed === 'owner') response.ownerScope = 'b'.repeat(64);
        if (changed === 'attempt')
          response.attempt.attemptId = crypto.randomUUID();
        if (changed === 'registered') response.attempt.state = 'registered';
      };
      await expect(
        withJitoRecoveryJournalLock(alice, guard, (token) =>
          reserveJitoImportedEvidence(
            token,
            f.manifest,
            0,
            password,
            f.swap.signed.transaction,
            '11111111-1111-4111-8111-111111111111',
            async () => response,
          ),
        ),
      ).rejects.toThrow();
      expect([...mock.rows.values()][0]).toMatchObject({ state: 'unknown' });
    },
  );
  it('binds a returned reservation to the exact verified transaction', async () => {
    const f = await fixture(),
      attempt = importedAttempt(f);
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        const reservation = await reserveJitoImportedEvidence(
          token,
          f.manifest,
          0,
          password,
          f.swap.signed.transaction,
          attempt.attemptId,
          async () => ({ ownerScope: alice, record: f.record, attempt }),
        );
        await retainJitoRecoverySignature(
          token,
          reservation,
          f.manifest,
          f.tip.signed.transaction,
        );
      }),
    ).rejects.toThrow();
    expect([...mock.rows.values()][0]).toMatchObject({ state: 'unknown' });
  });
});

describe('unintegrated same-origin recovery journal', () => {
  it('only acknowledges an exact retained signature independently registered on the server', async () => {
    const f = await fixture();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      const r = await reserveJitoRecoveryUnknown(
        token,
        f.manifest,
        0,
        password,
        f.fresh,
      );
      await retainJitoRecoverySignature(
        token,
        r,
        f.manifest,
        f.swap.signed.transaction,
      );
    });
    const ack = (pass = password, fresh = f.fresh) =>
      withJitoRecoveryJournalLock(alice, guard, (token) =>
        acknowledgeJitoRecoveryRegistered(token, f.manifest, 0, pass, fresh),
      );
    await expect(ack()).rejects.toThrow();
    f.record.signatures[0] = f.swap.signed.signature;
    await expect(ack('wrong password')).rejects.toThrow();
    await expect(
      ack(password, async () => ({
        ownerScope: 'b'.repeat(64),
        record: f.record,
      })),
    ).rejects.toThrow();
    mock.fault = 'delete-before';
    await expect(ack()).rejects.toThrow();
    expect(mock.rows.size).toBe(1);
    mock.fault = '';
    mock.beforeDelete = async () => {
      const current = [...mock.rows.values()][0] as { nonce: string };
      current.nonce = '0'.repeat(32);
    };
    await expect(ack()).rejects.toThrow();
    expect(mock.rows.size).toBe(1);
  });

  it('reclaims capacity only for a verified registered signature and never deletes unknown', async () => {
    const f = await fixture();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      const r = await reserveJitoRecoveryUnknown(
        token,
        f.manifest,
        0,
        password,
        f.fresh,
      );
      await retainJitoRecoverySignature(
        token,
        r,
        f.manifest,
        f.swap.signed.transaction,
      );
    });
    for (let i = 0; i < 99; i++) mock.rows.set(`occupied-${i}`, {});
    await expect(
      withJitoRecoveryJournalLock(alice, guard, (token) =>
        reserveJitoRecoveryUnknown(token, f.manifest, 1, password, f.fresh),
      ),
    ).rejects.toThrow();
    expect(mock.rows.size).toBe(100);
    f.record.signatures[0] = f.swap.signed.signature;
    await withJitoRecoveryJournalLock(alice, guard, (token) =>
      acknowledgeJitoRecoveryRegistered(
        token,
        f.manifest,
        0,
        password,
        f.fresh,
      ),
    );
    expect(mock.rows.size).toBe(99);
    f.record.signatures[0] = null;
    await withJitoRecoveryJournalLock(alice, guard, (token) =>
      reserveJitoRecoveryUnknown(token, f.manifest, 0, password, f.fresh),
    );
    await expect(
      withJitoRecoveryJournalLock(alice, guard, (token) =>
        acknowledgeJitoRecoveryRegistered(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        ),
      ),
    ).rejects.toThrow();
    expect(mock.rows.size).toBe(100);
  });

  it('reports ambiguous delete failure instead of claiming reconciliation succeeded', async () => {
    const f = await fixture();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      const r = await reserveJitoRecoveryUnknown(
        token,
        f.manifest,
        0,
        password,
        f.fresh,
      );
      await retainJitoRecoverySignature(
        token,
        r,
        f.manifest,
        f.swap.signed.transaction,
      );
    });
    f.record.signatures[0] = f.swap.signed.signature;
    mock.fault = 'delete-after';
    await expect(
      withJitoRecoveryJournalLock(alice, guard, (token) =>
        acknowledgeJitoRecoveryRegistered(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        ),
      ),
    ).rejects.toThrow();
    expect(mock.rows.size).toBe(0);
  });
  it('discovers only scoped markers and fails closed if the authenticated owner changes', async () => {
    const f = await fixture();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      await reserveJitoRecoveryUnknown(token, f.manifest, 0, password, f.fresh);
      expect(
        await listJitoRecoveryJournalPending(
          token,
          f.manifest.projectId,
          f.manifest.sessionId,
          async () => alice,
        ),
      ).toEqual([{ bundleId: f.manifest.id, packet: 0, status: 'unknown' }]);
    });
    let reads = 0;
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await listJitoRecoveryJournalPending(
          token,
          f.manifest.projectId,
          f.manifest.sessionId,
          async () => (++reads === 1 ? alice : 'b'.repeat(64)),
        );
      }),
    ).rejects.toThrow();
    const duplicate = structuredClone([...mock.rows.values()][0]);
    mock.rows.set('duplicate', duplicate);
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await listJitoRecoveryJournalPending(
          token,
          f.manifest.projectId,
          f.manifest.sessionId,
          async () => alice,
        );
      }),
    ).rejects.toThrow();
  });

  it('uses a separately domain-bound KDF and nonextractable encryption key', async () => {
    const f = await fixture();
    const real = crypto.subtle.deriveKey.bind(crypto.subtle);
    let snapshot:
      | { salt: number[]; iterations: number; extractable: boolean }
      | undefined;
    const spy = vi
      .spyOn(crypto.subtle, 'deriveKey')
      .mockImplementation(
        async (algorithm, baseKey, derivedKeyType, extractable, usages) => {
          const params = algorithm as Pbkdf2Params;
          snapshot = {
            salt: [...new Uint8Array(params.salt as ArrayBuffer)],
            iterations: params.iterations,
            extractable,
          };
          return real(algorithm, baseKey, derivedKeyType, extractable, usages);
        },
      );
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      await reserveJitoRecoveryUnknown(token, f.manifest, 0, password, f.fresh);
    });
    expect(spy).toHaveBeenCalled();
    const prefix = [
      ...new TextEncoder().encode(
        'PulseForge/JitoRecoveryJournal/v1/PBKDF2-SHA256',
      ),
    ];
    expect(snapshot?.salt.slice(0, prefix.length)).toEqual(prefix);
    expect(snapshot?.salt[prefix.length]).toBe(0);
    expect(snapshot?.salt.length).toBe(prefix.length + 17);
    expect(snapshot?.iterations).toBe(600000);
    expect(snapshot?.extractable).toBe(false);
  });

  it('poisons a scope after a swallowed failure but still retains an already returned exact signature', async () => {
    const f = await fixture();
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        const r = await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
        await expect(
          inspectJitoRecoveryJournal(
            token,
            f.manifest,
            0,
            password,
            async () => ({
              ownerScope: 'b'.repeat(64),
              record: f.record,
            }),
          ),
        ).rejects.toThrow();
        await expect(
          reserveJitoRecoveryUnknown(token, f.manifest, 1, password, f.fresh),
        ).rejects.toThrow();
        await retainJitoRecoverySignature(
          token,
          r,
          f.manifest,
          f.swap.signed.transaction,
        );
      }),
    ).rejects.toThrow();
    expect(mock.rows.size).toBe(1);
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      expect(
        (
          await inspectJitoRecoveryJournal(
            token,
            f.manifest,
            0,
            password,
            f.fresh,
          )
        ).status,
      ).toBe('retained');
    });
  });

  it('fails the lock scope when an unawaited queued operation fails', async () => {
    const f = await fixture();
    mock.fault = 'insert-before';
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        void reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        ).catch(() => {});
      }),
    ).rejects.toThrow();
    expect(mock.rows.size).toBe(0);
  });
  it.each([0, 1])(
    'encrypts and rechecks only the exact signature for packet %s',
    async (packet) => {
      const f = await fixture();
      const signed = packet ? f.tip.signed : f.swap.signed;
      await withJitoRecoveryJournalLock(alice, guard, async (token) => {
        const reservation = await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          packet,
          password,
          f.fresh,
        );
        expect(
          await inspectJitoRecoveryJournal(
            token,
            f.manifest,
            packet,
            password,
            f.fresh,
          ),
        ).toEqual({ status: 'unknown' });
        await retainJitoRecoverySignature(
          token,
          reservation,
          f.manifest,
          signed.transaction,
        );
        const result = await inspectJitoRecoveryJournal(
          token,
          f.manifest,
          packet,
          password,
          f.fresh,
        );
        expect(result).toEqual({
          status: 'retained',
          signature: signed.signature,
          transaction: signed.transaction,
        });
        const stored = JSON.stringify([...mock.rows.values()]);
        expect(stored).not.toContain(signed.signature);
        expect(stored).not.toContain(signed.transaction);
        expect(stored).not.toContain(password);
        expect(stored).not.toContain('seed');
      });
    },
  );

  it('survives a new lock scope and refuses wrong passwords without deleting the marker', async () => {
    const f = await fixture();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      const r = await reserveJitoRecoveryUnknown(
        token,
        f.manifest,
        0,
        password,
        f.fresh,
      );
      await retainJitoRecoverySignature(
        token,
        r,
        f.manifest,
        f.swap.signed.transaction,
      );
    });
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await inspectJitoRecoveryJournal(
          token,
          f.manifest,
          0,
          'wrong password',
          f.fresh,
        );
      }),
    ).rejects.toThrow('unavailable');
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      expect(
        (
          await inspectJitoRecoveryJournal(
            token,
            f.manifest,
            0,
            password,
            f.fresh,
          )
        ).status,
      ).toBe('retained');
    });
    expect(mock.rows.size).toBe(1);
  });

  it('keeps unknown after an ambiguous insert and refuses replacement', async () => {
    const f = await fixture();
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        mock.fault = 'insert-after';
        await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
      }),
    ).rejects.toThrow();
    mock.fault = '';
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      expect(
        await inspectJitoRecoveryJournal(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        ),
      ).toEqual({ status: 'unknown' });
    });
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
      }),
    ).rejects.toThrow();
    expect(mock.rows.size).toBe(1);
  });

  it('resumes an unknown marker only with the original password and an exact signed packet', async () => {
    const f = await fixture();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      await reserveJitoRecoveryUnknown(token, f.manifest, 0, password, f.fresh);
    });
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await resumeJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          'wrong password',
          f.fresh,
        );
      }),
    ).rejects.toThrow();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      expect(
        await inspectJitoRecoveryJournal(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        ),
      ).toEqual({ status: 'unknown' });
      const resumed = await resumeJitoRecoveryUnknown(
        token,
        f.manifest,
        0,
        password,
        f.fresh,
      );
      await retainJitoRecoverySignature(
        token,
        resumed,
        f.manifest,
        f.swap.signed.transaction,
      );
      expect(
        (
          await inspectJitoRecoveryJournal(
            token,
            f.manifest,
            0,
            password,
            f.fresh,
          )
        ).status,
      ).toBe('retained');
    });
  });

  it('retains the returned signature under its original owner after the UI context goes stale', async () => {
    const f = await fixture();
    let current = true;
    const assertCurrent = () => {
      if (!current) throw Error('context changed');
    };
    await expect(
      withJitoRecoveryJournalLock(alice, assertCurrent, async (token) => {
        const r = await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
        current = false;
        await retainJitoRecoverySignature(
          token,
          r,
          f.manifest,
          f.swap.signed.transaction,
        );
        await expect(
          inspectJitoRecoveryJournal(token, f.manifest, 0, password, f.fresh),
        ).rejects.toThrow();
      }),
    ).rejects.toThrow();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      expect(
        (
          await inspectJitoRecoveryJournal(
            token,
            f.manifest,
            0,
            password,
            f.fresh,
          )
        ).status,
      ).toBe('retained');
    });
  });

  it('continues exact capture when context changes after encryption but before the storage commit', async () => {
    const f = await fixture();
    let release!: () => void;
    let began!: () => void;
    let current = true;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const assertCurrent = () => {
      if (!current) throw Error('context changed');
    };
    mock.beforeRetain = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        began();
      });
    const outer = withJitoRecoveryJournalLock(
      alice,
      assertCurrent,
      async (token) => {
        const r = await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
        await retainJitoRecoverySignature(
          token,
          r,
          f.manifest,
          f.swap.signed.transaction,
        );
      },
    );
    await started;
    current = false;
    release();
    await expect(outer).rejects.toThrow('context changed');
    mock.beforeRetain = undefined;
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      expect(
        (
          await inspectJitoRecoveryJournal(
            token,
            f.manifest,
            0,
            password,
            f.fresh,
          )
        ).status,
      ).toBe('retained');
    });
  });

  it('preserves UNKNOWN when context changes and the signature commit fails', async () => {
    const f = await fixture();
    let current = true;
    const assertCurrent = () => {
      if (!current) throw Error('context changed');
    };
    await expect(
      withJitoRecoveryJournalLock(alice, assertCurrent, async (token) => {
        const r = await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
        current = false;
        mock.fault = 'cas-before';
        await retainJitoRecoverySignature(
          token,
          r,
          f.manifest,
          f.swap.signed.transaction,
        );
      }),
    ).rejects.toThrow();
    mock.fault = '';
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      expect(
        await inspectJitoRecoveryJournal(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        ),
      ).toEqual({ status: 'unknown' });
    });
  });

  it('keeps unknown after compare-and-set failure, and a later attempt cannot replace it', async () => {
    const f = await fixture();
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        const r = await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
        mock.fault = 'cas-before';
        await retainJitoRecoverySignature(
          token,
          r,
          f.manifest,
          f.swap.signed.transaction,
        );
      }),
    ).rejects.toThrow();
    mock.fault = '';
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      expect(
        await inspectJitoRecoveryJournal(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        ),
      ).toEqual({ status: 'unknown' });
    });
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
      }),
    ).rejects.toThrow();
  });

  it('preserves a sealed record when the commit outcome is ambiguous', async () => {
    const f = await fixture();
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        const r = await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
        mock.fault = 'cas-after';
        await retainJitoRecoverySignature(
          token,
          r,
          f.manifest,
          f.swap.signed.transaction,
        );
      }),
    ).rejects.toThrow();
    mock.fault = '';
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      expect(
        (
          await inspectJitoRecoveryJournal(
            token,
            f.manifest,
            0,
            password,
            f.fresh,
          )
        ).status,
      ).toBe('retained');
    });
  });

  it('refuses forged packet signatures while preserving UNKNOWN', async () => {
    const f = await fixture();
    const bytes = Uint8Array.from(atob(f.swap.signed.transaction), (v) =>
      v.charCodeAt(0),
    );
    bytes[1] ^= 1;
    const forged = btoa(String.fromCharCode(...bytes));
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        const r = await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
        await retainJitoRecoverySignature(token, r, f.manifest, forged);
      }),
    ).rejects.toThrow();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      expect(
        await inspectJitoRecoveryJournal(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        ),
      ).toEqual({ status: 'unknown' });
    });
  });

  it('detects ciphertext/identity tampering and never erases the record', async () => {
    const f = await fixture();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      const r = await reserveJitoRecoveryUnknown(
        token,
        f.manifest,
        0,
        password,
        f.fresh,
      );
      await retainJitoRecoverySignature(
        token,
        r,
        f.manifest,
        f.swap.signed.transaction,
      );
    });
    const key = [...mock.rows.keys()][0];
    const saved = mock.rows.get(key) as {
      ciphertext: string;
      identity: { wallet: string };
    };
    saved.ciphertext = `${saved.ciphertext[0] === 'a' ? 'b' : 'a'}${saved.ciphertext.slice(1)}`;
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await inspectJitoRecoveryJournal(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
      }),
    ).rejects.toThrow();
    saved.identity.wallet = 'different';
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await inspectJitoRecoveryJournal(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
      }),
    ).rejects.toThrow();
    expect(mock.rows.size).toBe(1);
  });

  it('requires fresh owner and exact state before and after reads', async () => {
    const f = await fixture();
    const wrong = async () => ({
      ownerScope: 'b'.repeat(64),
      record: structuredClone(f.record),
    });
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await reserveJitoRecoveryUnknown(token, f.manifest, 0, password, wrong);
      }),
    ).rejects.toThrow();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      const r = await reserveJitoRecoveryUnknown(
        token,
        f.manifest,
        0,
        password,
        f.fresh,
      );
      await retainJitoRecoverySignature(
        token,
        r,
        f.manifest,
        f.swap.signed.transaction,
      );
    });
    let calls = 0;
    const changed = async () => {
      const record = structuredClone(f.record);
      if (++calls === 2) record.state = 'cancelled';
      return { ownerScope: alice, record };
    };
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await inspectJitoRecoveryJournal(
          token,
          f.manifest,
          0,
          password,
          changed,
        );
      }),
    ).rejects.toThrow();
    expect(mock.rows.size).toBe(1);
  });

  it('snapshots repeated mutable fresh records so a state change cannot alter the first read', async () => {
    const f = await fixture();
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      const r = await reserveJitoRecoveryUnknown(
        token,
        f.manifest,
        0,
        password,
        f.fresh,
      );
      await retainJitoRecoverySignature(
        token,
        r,
        f.manifest,
        f.swap.signed.transaction,
      );
    });
    let calls = 0;
    const reused = async () => {
      if (++calls === 2) f.record.state = 'cancelled';
      return { ownerScope: alice, record: f.record };
    };
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await inspectJitoRecoveryJournal(
          token,
          f.manifest,
          0,
          password,
          reused,
        );
      }),
    ).rejects.toThrow();
  });

  it('rejects expired/replaced review, short passwords and unavailable locks before writing', async () => {
    const f = await fixture();
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          'short',
          f.fresh,
        );
      }),
    ).rejects.toThrow();
    f.record.state = 'cancelled';
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async (token) => {
        await reserveJitoRecoveryUnknown(
          token,
          f.manifest,
          0,
          password,
          f.fresh,
        );
      }),
    ).rejects.toThrow();
    expect(mock.rows.size).toBe(0);
    vi.stubGlobal('navigator', {});
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async () => {}),
    ).rejects.toThrow();
  });

  it.each(['a'.repeat(1025), '🌙'.repeat(513)])(
    'rejects overlong passwords before writing',
    async (tooLong) => {
      const f = await fixture();
      await expect(
        withJitoRecoveryJournalLock(alice, guard, (token) =>
          reserveJitoRecoveryUnknown(token, f.manifest, 0, tooLong, f.fresh),
        ),
      ).rejects.toThrow();
      expect(mock.rows.size).toBe(0);
    },
  );

  it('serializes concurrent owner operations and invalidates the lock token after release', async () => {
    const f = await fixture();
    let saved!: JitoJournalLock;
    await withJitoRecoveryJournalLock(alice, guard, async (token) => {
      saved = token;
      await expect(
        withJitoRecoveryJournalLock(alice, guard, async () => {}),
      ).rejects.toThrow();
      await expect(
        inspectJitoRecoveryJournal({}, f.manifest, 0, password, f.fresh),
      ).rejects.toThrow('lock');
    });
    await expect(
      inspectJitoRecoveryJournal(saved, f.manifest, 0, password, f.fresh),
    ).rejects.toThrow('lock');
  });

  it('does not release the lock while an unawaited storage operation remains in flight', async () => {
    const f = await fixture();
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    mock.beforeInsert = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        began();
      });
    let complete = false;
    const outer = withJitoRecoveryJournalLock(alice, guard, async (token) => {
      void reserveJitoRecoveryUnknown(
        token,
        f.manifest,
        0,
        password,
        f.fresh,
      ).catch(() => {});
    }).then(() => {
      complete = true;
    });
    await started;
    expect(complete).toBe(false);
    await expect(
      withJitoRecoveryJournalLock(alice, guard, async () => {}),
    ).rejects.toThrow();
    release();
    await outer;
    expect(complete).toBe(true);
    expect(mock.rows.size).toBe(1);
  });
});
