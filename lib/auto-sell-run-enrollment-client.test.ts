import { describe, expect, it, vi } from 'vitest';
import { savedProfile, profileWallet } from '@/test/auto-sell-profile-fixture';
import { createAutoSellRun, type AutoSellRun } from './auto-sell-run';
import {
  autoSellRunEnrollmentScope as scope,
  autoSellRunEnrollmentKey as key,
  readAutoSellRunEnrollmentReminder as read,
  loadAutoSellRunEnrollmentReminder as load,
  reviewAutoSellRunEnrollmentProfile as review,
  recordAutoSellRunEnrollment as record,
  recoverAutoSellRunEnrollment as recover,
} from './auto-sell-run-enrollment-client';

const flags = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
};
const stamp = '2026-10-25T00:00:01.000Z';
const fixedId = '30000000-0000-4000-8000-000000000001';
const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: vi.fn((k: string) => map.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => {
      map.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      map.delete(k);
    }),
  };
}
function locking() {
  const held = new Set<string>();
  const request = vi.fn(
    async (
      name: string,
      _options: unknown,
      callback: (lock: Lock | null) => unknown,
    ) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: 'exclusive' } as Lock);
      } finally {
        held.delete(name);
      }
    },
  );
  return { held, request: request as unknown as LockManager['request'] };
}
function full(run: AutoSellRun) {
  return {
    run,
    accounting: {
      sequence: 0,
      headSha256: run.sha256,
      accountedRaw: '0',
      strategies: run.profile.terms.configuration.strategies.map((s) => ({
        id: s.id,
        accountedRaw: '0',
        claimedKeyCount: 0,
        nextDcaIndex: 0,
        nextDcaAt: null,
      })),
    },
    preparationStarts: [],
    stopped: false,
    stop: null,
    ...flags,
  };
}
async function fixture() {
  const profile = await savedProfile();
  const target = {
    ownerScope: await scope('alice'),
    projectId: profile.terms.projectId,
    profileSaveId: profile.id,
    profileSha256: profile.sha256,
  };
  const reminder = {
    format: 'auto-sell-run-enrollment-v1' as const,
    ...target,
    runId: fixedId,
  };
  const roster = [
    { address: profileWallet.address, revision: 1, archived: false },
  ];
  const run = await createAutoSellRun(fixedId, profile, roster, stamp);
  const storage = memory(),
    locks = locking();
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string);
      return json({
        run: await createAutoSellRun(body.id, profile, roster, stamp),
        ...flags,
      });
    }
    return (typeof _url === 'string'
      ? _url
      : _url instanceof URL
        ? _url.href
        : _url.url
    ).includes('auto-sell-profiles')
      ? json({ profile, ...flags })
      : json(full(run));
  }) as unknown as typeof fetch;
  const reviewed = await review(target, signal(), fetcher);
  return {
    profile,
    target,
    reminder,
    run,
    storage,
    locks,
    fetcher,
    reviewed,
    options: { storage, locks, fetcher },
  };
}
describe('Auto Sell original run enrollment', () => {
  it('serializes two clicks and consumes the review only once', async () => {
    const f = await fixture();
    const input = {
      ...f.target,
      profile: f.reviewed,
      approved: true,
      mode: 'new' as const,
    };
    const results = await Promise.allSettled([
      record(input, signal(), f.options),
      record(input, signal(), f.options),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.storage.setItem).toHaveBeenCalledTimes(1);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('captures requested identity before a caller mutates it during profile reading', async () => {
    const f = await fixture();
    const input = { ...f.target };
    const pending = review(input, signal(), f.fetcher);
    input.ownerScope = await scope('bob');
    const profile = await pending;
    await expect(
      record(
        { ...input, profile, approved: true, mode: 'new' },
        signal(),
        f.options,
      ),
    ).rejects.toThrow('review');
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });
  it('keeps the original marker for a changed POST acknowledgement', async () => {
    const f = await fixture();
    await expect(
      record(
        { ...f.target, profile: f.reviewed, approved: true, mode: 'new' },
        signal(),
        {
          ...f.options,
          fetcher: vi.fn(async () => json({ run: f.run, ...flags })),
        },
      ),
    ).rejects.toThrow();
    expect(
      load(f.target.ownerScope, f.target.projectId, f.storage),
    ).not.toBeNull();
  });
  it('does not clear a newer marker installed while GET is pending', async () => {
    const f = await fixture();
    f.storage.map.set(
      key(f.target.ownerScope, f.target.projectId),
      JSON.stringify(f.reminder),
    );
    const replacement = {
      ...f.reminder,
      runId: '70000000-0000-4000-8000-000000000001',
    };
    const fetcher = vi.fn(async () => {
      f.storage.map.set(
        key(f.target.ownerScope, f.target.projectId),
        JSON.stringify(replacement),
      );
      return json(full(f.run));
    });
    expect(
      (await recover(f.reminder, signal(), { ...f.options, fetcher }))
        .reminderRetained,
    ).toBe(true);
    expect(load(f.target.ownerScope, f.target.projectId, f.storage)).toEqual(
      replacement,
    );
  });
  it('can verify recovery without a lock but keeps a pending reference', async () => {
    const f = await fixture();
    f.storage.map.set(
      key(f.target.ownerScope, f.target.projectId),
      JSON.stringify(f.reminder),
    );
    expect(
      (await recover(f.reminder, signal(), { ...f.options, locks: null }))
        .reminderRetained,
    ).toBe(true);
    expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it('does not clear recovery after local cancellation and a late response', async () => {
    const f = await fixture();
    f.storage.map.set(
      key(f.target.ownerScope, f.target.projectId),
      JSON.stringify(f.reminder),
    );
    let finish!: (r: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = recover(f.reminder, controller.signal, {
      ...f.options,
      fetcher,
    });
    controller.abort();
    await expect(pending).rejects.toThrow('does not cancel');
    finish(json(full(f.run)));
    await Promise.resolve();
    expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'hash', 'authority', 'truncated'])(
    'rejects %s explicit profile reads',
    async (kind) => {
      const f = await fixture();
      const body = { profile: structuredClone(f.profile), ...flags };
      if (kind === 'foreign')
        body.profile.id = '80000000-0000-4000-8000-000000000001';
      if (kind === 'hash') body.profile.sha256 = 'f'.repeat(64);
      if (kind === 'authority')
        (body as Record<string, unknown>).automaticResumeAllowed = true;
      await expect(
        review(
          f.target,
          signal(),
          vi.fn(async () =>
            kind === 'truncated'
              ? new Response('{', {
                  headers: { 'content-type': 'application/json' },
                })
              : json(body),
          ),
        ),
      ).rejects.toThrow('could not be verified');
    },
  );
  it('uses stable opaque owner/project keys independent of selected profile', async () => {
    const f = await fixture();
    expect(await scope('alice')).toBe(f.target.ownerScope);
    expect(await scope('bob')).not.toBe(f.target.ownerScope);
    expect(key(f.target.ownerScope, f.target.projectId)).not.toContain('alice');
    expect(load(f.target.ownerScope, f.target.projectId, f.storage)).toBeNull();
  });
  it('persists only metadata before one exact consenting POST and clears only verified acknowledgement', async () => {
    const f = await fixture();
    const network = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const pending = load(
          f.target.ownerScope,
          f.target.projectId,
          f.storage,
        )!;
        expect(Object.keys(pending).sort()).toEqual(
          [
            'format',
            'ownerScope',
            'profileSaveId',
            'profileSha256',
            'projectId',
            'runId',
          ].sort(),
        );
        expect(JSON.parse(init?.body as string)).toEqual({
          action: 'create',
          id: pending.runId,
          projectId: pending.projectId,
          profileSaveId: pending.profileSaveId,
          profileSha256: pending.profileSha256,
          consent: 'record-auto-sell-run-v1',
        });
        expect(init).toMatchObject({
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
        });
        return f.fetcher(url, init);
      },
    );
    const result = await record(
      { ...f.target, profile: f.reviewed, approved: true, mode: 'new' },
      signal(),
      { ...f.options, fetcher: network },
    );
    expect(result.run.id).toBe(result.reminder.runId);
    expect(result.reminderRetained).toBe(false);
    expect(network).toHaveBeenCalledTimes(1);
    expect(f.storage.map.size).toBe(0);
    await expect(
      record(
        { ...f.target, profile: f.reviewed, approved: true, mode: 'new' },
        signal(),
        f.options,
      ),
    ).rejects.toThrow('review');
  });
  it.each([false, undefined, 1])(
    'requires a separate true approval: %s',
    async (approved) => {
      const f = await fixture();
      await expect(
        record(
          {
            ...f.target,
            profile: f.reviewed,
            approved: approved as boolean,
            mode: 'new',
          },
          signal(),
          f.options,
        ),
      ).rejects.toThrow('approve');
      expect(f.storage.setItem).not.toHaveBeenCalled();
    },
  );
  it('rejects unreviewed parent profiles and changed reviewed terms', async () => {
    const f = await fixture();
    await expect(
      record(
        { ...f.target, profile: f.profile, approved: true, mode: 'new' },
        signal(),
        f.options,
      ),
    ).rejects.toThrow('review');
    f.reviewed.terms.name = 'Changed';
    await expect(
      record(
        { ...f.target, profile: f.reviewed, approved: true, mode: 'new' },
        signal(),
        f.options,
      ),
    ).rejects.toThrow();
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });
  it('blocks every new ID while the owner/project has any pending profile', async () => {
    const f = await fixture();
    f.storage.map.set(
      key(f.target.ownerScope, f.target.projectId),
      JSON.stringify({
        ...f.reminder,
        profileSaveId: '40000000-0000-4000-8000-000000000001',
      }),
    );
    await expect(
      record(
        { ...f.target, profile: f.reviewed, approved: true, mode: 'new' },
        signal(),
        f.options,
      ),
    ).rejects.toThrow('original');
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });
  it('requires a fresh exact original-profile review before same-ID manual retry', async () => {
    const f = await fixture();
    f.storage.map.set(
      key(f.target.ownerScope, f.target.projectId),
      JSON.stringify(f.reminder),
    );
    await expect(
      record(
        {
          ...f.target,
          runId: fixedId,
          profile: f.reviewed,
          approved: true,
          mode: 'retry',
        },
        signal(),
        f.options,
      ),
    ).rejects.toThrow('review');
    const profile = await review(
      { ...f.target, runId: fixedId },
      signal(),
      f.fetcher,
    );
    const result = await record(
      { ...f.target, runId: fixedId, profile, approved: true, mode: 'retry' },
      signal(),
      f.options,
    );
    expect(result.run.id).toBe(fixedId);
  });
  it.each(['malformed', 'foreign', 'oversized'])(
    'blocks new records on %s stored metadata',
    async (kind) => {
      const f = await fixture();
      f.storage.map.set(
        key(f.target.ownerScope, f.target.projectId),
        kind === 'malformed'
          ? '{'
          : kind === 'oversized'
            ? 'x'.repeat(1025)
            : JSON.stringify({ ...f.reminder, ownerScope: await scope('bob') }),
      );
      await expect(
        record(
          { ...f.target, profile: f.reviewed, approved: true, mode: 'new' },
          signal(),
          f.options,
        ),
      ).rejects.toThrow('storage');
      expect(f.storage.setItem).not.toHaveBeenCalled();
    },
  );
  it('refuses missing locks and contending tabs without a POST', async () => {
    const f = await fixture();
    await expect(
      record(
        { ...f.target, profile: f.reviewed, approved: true, mode: 'new' },
        signal(),
        { ...f.options, locks: null },
      ),
    ).rejects.toThrow('browser');
    f.locks.held.add(key(f.target.ownerScope, f.target.projectId));
    await expect(
      record(
        { ...f.target, profile: f.reviewed, approved: true, mode: 'new' },
        signal(),
        f.options,
      ),
    ).rejects.toThrow('Another tab');
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });
  it.each(['throw', 'silent'])(
    'does not dispatch when persistence/readback fails: %s',
    async (kind) => {
      const f = await fixture();
      f.storage.setItem.mockImplementation(() => {
        if (kind === 'throw') throw Error('secret-storage-path');
      });
      await expect(
        record(
          { ...f.target, profile: f.reviewed, approved: true, mode: 'new' },
          signal(),
          f.options,
        ),
      ).rejects.toThrow('storage');
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('retains unknown saves after abort and releases the lock even if transport ignores cancellation', async () => {
    const f = await fixture();
    let dispatched!: () => void;
    const sent = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    let late!: (response: Response) => void;
    const hanging = vi.fn(() => {
      dispatched();
      return new Promise<Response>((resolve) => {
        late = resolve;
      });
    });
    const controller = new AbortController();
    const pending = record(
      { ...f.target, profile: f.reviewed, approved: true, mode: 'new' },
      controller.signal,
      { ...f.options, fetcher: hanging },
    );
    await sent;
    const reminder = load(f.target.ownerScope, f.target.projectId, f.storage)!;
    controller.abort();
    await expect(pending).rejects.toThrow('does not cancel');
    await Promise.resolve();
    expect(f.locks.held.size).toBe(0);
    late(json({ run: f.run, ...flags }));
    await Promise.resolve();
    expect(load(f.target.ownerScope, f.target.projectId, f.storage)).toEqual(
      reminder,
    );
    const serverRun = await createAutoSellRun(
      reminder.runId,
      f.profile,
      [{ address: profileWallet.address, revision: 1, archived: false }],
      stamp,
    );
    const recovered = await recover(reminder, signal(), {
      ...f.options,
      fetcher: vi.fn(async () => json(full(serverRun))),
    });
    expect(recovered.reminderRetained).toBe(false);
  });
  it.each([404, 202, 408, 409, 401])(
    'never clears an original reminder after status %i',
    async (status) => {
      const f = await fixture();
      f.storage.map.set(
        key(f.target.ownerScope, f.target.projectId),
        JSON.stringify(f.reminder),
      );
      await expect(
        recover(f.reminder, signal(), {
          ...f.options,
          fetcher: vi.fn(async () =>
            json({ error: 'private-details' }, status),
          ),
        }),
      ).rejects.toThrow('could not be verified');
      expect(load(f.target.ownerScope, f.target.projectId, f.storage)).toEqual(
        f.reminder,
      );
    },
  );
  it.each([
    'foreign-id',
    'hash',
    'authority',
    'unknown-field',
    'accounting',
    'stop',
  ])('refuses %s recovery without deleting metadata', async (kind) => {
    const f = await fixture();
    f.storage.map.set(
      key(f.target.ownerScope, f.target.projectId),
      JSON.stringify(f.reminder),
    );
    const body = full(f.run);
    if (kind === 'foreign-id')
      body.run = await createAutoSellRun(
        '40000000-0000-4000-8000-000000000001',
        f.profile,
        f.run.ownWallets,
        stamp,
      );
    if (kind === 'hash') body.run.sha256 = '0'.repeat(64);
    if (kind === 'authority')
      (body as Record<string, unknown>).signingAllowed = true;
    if (kind === 'unknown-field') (body as Record<string, unknown>).extra = 1;
    if (kind === 'accounting') body.accounting.accountedRaw = '1';
    if (kind === 'stop') body.stopped = true;
    await expect(
      recover(f.reminder, signal(), {
        ...f.options,
        fetcher: vi.fn(async () => json(body)),
      }),
    ).rejects.toThrow();
    expect(load(f.target.ownerScope, f.target.projectId, f.storage)).toEqual(
      f.reminder,
    );
  });
  it('confirms historical expired/stopped runs without implying empty progress', async () => {
    const f = await fixture();
    f.storage.map.set(
      key(f.target.ownerScope, f.target.projectId),
      JSON.stringify(f.reminder),
    );
    const body = {
      ...full(f.run),
      stopped: true,
      stop: {
        format: 'auto-sell-run-stop-v1',
        id: '50000000-0000-4000-8000-000000000001',
        runId: f.run.id,
        runSha256: f.run.sha256,
        createdAt: stamp,
        ...flags,
      },
    };
    body.accounting.sequence = 1;
    body.accounting.headSha256 = 'a'.repeat(64);
    body.accounting.accountedRaw = '5';
    body.accounting.strategies[0].accountedRaw = '5';
    const result = await recover(f.reminder, signal(), {
      ...f.options,
      fetcher: vi.fn(async () => json(body)),
    });
    expect(result.run).toEqual(f.run);
    expect(result.reminderRetained).toBe(false);
  });
  it('returns confirmed plus retained when removal fails or another marker replaces it', async () => {
    const f = await fixture();
    f.storage.map.set(
      key(f.target.ownerScope, f.target.projectId),
      JSON.stringify(f.reminder),
    );
    f.storage.removeItem.mockImplementation(() => {
      throw Error('denied');
    });
    expect(
      (await recover(f.reminder, signal(), f.options)).reminderRetained,
    ).toBe(true);
    f.storage.map.set(
      key(f.target.ownerScope, f.target.projectId),
      JSON.stringify({
        ...f.reminder,
        runId: '60000000-0000-4000-8000-000000000001',
      }),
    );
    expect(
      (await recover(f.reminder, signal(), f.options)).reminderRetained,
    ).toBe(true);
  });
  it('can inspect original records after the local reminder was already cleared without writing storage', async () => {
    const f = await fixture();
    expect(
      (await recover(f.reminder, signal(), { ...f.options, locks: null }))
        .reminderRetained,
    ).toBe(false);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(['HTML', 'network', 'broken-json'])(
    'sanitizes %s errors',
    async (kind) => {
      const f = await fixture();
      const fetcher = vi.fn(async () => {
        if (kind === 'network') throw Error('https://private.invalid/key');
        return kind === 'HTML'
          ? new Response('<h1>private-wallet-key</h1>')
          : new Response('{private-wallet-key', {
              headers: { 'content-type': 'application/json' },
            });
      });
      await expect(
        recover(f.reminder, signal(), { ...f.options, fetcher }),
      ).rejects.toThrow('could not be verified');
    },
  );
  it.each(['accessor', 'hidden', 'symbol', 'prototype', 'extra'])(
    'refuses %s reminder shapes without invoking accessors',
    async (kind) => {
      const f = await fixture();
      const value = { ...f.reminder };
      const getter = vi.fn(() => f.target.ownerScope);
      if (kind === 'accessor')
        Object.defineProperty(value, 'ownerScope', {
          enumerable: true,
          get: getter,
        });
      if (kind === 'hidden')
        Object.defineProperty(value, 'ownerScope', {
          enumerable: false,
          value: f.target.ownerScope,
        });
      if (kind === 'symbol')
        Object.defineProperty(value, Symbol('hidden'), { value: true });
      if (kind === 'prototype')
        Object.setPrototypeOf(value, { malicious: true });
      if (kind === 'extra') Object.assign(value, { terms: 'forbidden' });
      expect(() => read(value)).toThrow();
      expect(getter).not.toHaveBeenCalled();
    },
  );
});
