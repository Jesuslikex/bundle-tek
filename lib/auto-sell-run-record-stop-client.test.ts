import { describe, expect, it, vi } from 'vitest';
import { savedProfile, profileWallet } from '@/test/auto-sell-profile-fixture';
import { createAutoSellRun } from './auto-sell-run';
import { autoSellRunRecordStopRequestSha256 } from './auto-sell-run-record-stop';
import {
  autoSellRunEnrollmentScope,
  autoSellRunEnrollmentKey,
} from './auto-sell-run-enrollment-client';
import {
  loadAutoSellRunRecordStopCapability as capability,
  stopAutoSellRunRecord as stop,
  recoverAutoSellRunRecordStop as recover,
  AutoSellRunRecordStopNotFoundError,
} from './auto-sell-run-record-stop-client';
const flags = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
};
const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
async function fixture() {
  const profile = await savedProfile();
  const reminder = {
    format: 'auto-sell-run-enrollment-v1' as const,
    ownerScope: await autoSellRunEnrollmentScope('alice'),
    projectId: profile.terms.projectId,
    runId: '30000000-0000-4000-8000-000000000001',
    profileSaveId: profile.id,
    profileSha256: profile.sha256,
  };
  const request = {
    projectId: reminder.projectId,
    runId: reminder.runId,
    profileSaveId: reminder.profileSaveId,
    profileSha256: reminder.profileSha256,
    consent: 'stop-original-run-record-v1' as const,
  };
  const receipt = {
    format: 'auto-sell-run-record-stop-v1' as const,
    projectId: reminder.projectId,
    runId: reminder.runId,
    profileSaveId: reminder.profileSaveId,
    profileSha256: reminder.profileSha256,
    requestSha256: await autoSellRunRecordStopRequestSha256(request),
    status: 'creation-fenced' as const,
    runSha256: null,
    createdAt: '2026-10-25T00:00:01.000Z',
    ...flags,
  };
  const body = {
    ownerScope: reminder.ownerScope,
    stop: receipt,
    run: null,
    ...flags,
  };
  const key = autoSellRunEnrollmentKey(reminder.ownerScope, reminder.projectId);
  const map = new Map([[key, JSON.stringify(reminder)]]);
  const storage = {
    getItem: vi.fn((k: string) => map.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => {
      map.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      map.delete(k);
    }),
  };
  let held = false;
  const locks = {
    request: vi.fn(
      async (
        _key: string,
        _options: unknown,
        callback: (lock: Lock | null) => unknown,
      ) => {
        if (held) return callback(null);
        held = true;
        try {
          return await callback({ name: _key, mode: 'exclusive' } as Lock);
        } finally {
          held = false;
        }
      },
    ) as unknown as LockManager['request'],
  };
  const fetcher = vi.fn(async () => json(body));
  return {
    reminder,
    request,
    receipt,
    body,
    key,
    map,
    storage,
    locks,
    fetcher,
    options: { storage, locks, fetcher },
  };
}
describe('terminal original run-record stop client', () => {
  it('checks exact owner capability with false authority and GET only', async () => {
    const f = await fixture();
    const fetcher = vi.fn(async () =>
      json({
        ownerScope: f.reminder.ownerScope,
        recordStopSupported: true,
        ...flags,
      }),
    );
    expect(await capability(f.reminder.ownerScope, signal(), fetcher)).toEqual({
      ownerScope: f.reminder.ownerScope,
      recordStopSupported: true,
      ...flags,
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/imported-projects/auto-sell-run-record-stops?capability=1',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      }),
    );
  });
  it.each(['owner', 'authority', 'missing', 'extra'])(
    'refuses %s capability',
    async (kind) => {
      const f = await fixture();
      const body: Record<string, unknown> = {
        ownerScope: f.reminder.ownerScope,
        recordStopSupported: true,
        ...flags,
      };
      if (kind === 'owner') body.ownerScope = 'f'.repeat(64);
      if (kind === 'authority') body.signingAllowed = true;
      if (kind === 'missing') delete body.executionAllowed;
      if (kind === 'extra') body.extra = true;
      await expect(
        capability(
          f.reminder.ownerScope,
          signal(),
          vi.fn(async () => json(body)),
        ),
      ).rejects.toThrow();
    },
  );
  it('sends only exact original metadata with separate stop consent and clears under the original lock', async () => {
    const f = await fixture();
    const result = await stop(
      { reminder: f.reminder, approved: true },
      signal(),
      f.options,
    );
    expect(result.stop).toEqual(f.receipt);
    expect(result.run).toBeNull();
    expect(result.reminderRetained).toBe(false);
    expect(f.fetcher).toHaveBeenCalledWith(
      '/api/imported-projects/auto-sell-run-record-stops',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(f.request),
      }),
    );
    expect(f.locks.request).toHaveBeenCalledWith(
      f.key,
      { ifAvailable: true },
      expect.any(Function),
    );
    expect(f.map.size).toBe(0);
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });
  it('requires a separate unchecked approval before sending', async () => {
    const f = await fixture();
    expect(() =>
      stop({ reminder: f.reminder, approved: false }, signal(), f.options),
    ).toThrow('Separately approve');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.map.size).toBe(1);
  });
  it('recovers a lost reply using the same original ID and does not POST again', async () => {
    const f = await fixture();
    await expect(
      stop({ reminder: f.reminder, approved: true }, signal(), {
        ...f.options,
        fetcher: vi.fn(async () => {
          throw Error('lost');
        }),
      }),
    ).rejects.toThrow();
    expect(f.map.size).toBe(1);
    expect(
      (await recover(f.reminder, signal(), f.options)).reminderRetained,
    ).toBe(false);
    expect(f.fetcher).toHaveBeenCalledWith(
      '/api/imported-projects/auto-sell-run-record-stops?runId=' +
        f.reminder.runId,
      expect.objectContaining({ method: 'GET' }),
    );
  });
  it('preserves an existing original immutable run instead of stopping it', async () => {
    const f = await fixture();
    const profile = await savedProfile();
    const run = await createAutoSellRun(
      f.reminder.runId,
      profile,
      [{ address: profileWallet.address, revision: 1, archived: false }],
      '2026-10-25T00:00:01.000Z',
    );
    const body = {
      ...f.body,
      stop: { ...f.receipt, status: 'record-found', runSha256: run.sha256 },
      run,
    };
    const result = await recover(f.reminder, signal(), {
      ...f.options,
      fetcher: vi.fn(async () => json(body)),
    });
    expect(result.run).toEqual(run);
    expect(result.stop.status).toBe('record-found');
    expect(result.reminderRetained).toBe(false);
    expect(result.run?.signingAllowed).toBe(false);
  });
  it('returns a typed no-proof result for null without clearing', async () => {
    const f = await fixture();
    await expect(
      recover(f.reminder, signal(), {
        ...f.options,
        fetcher: vi.fn(async () => json({ ...f.body, stop: null })),
      }),
    ).rejects.toBeInstanceOf(AutoSellRunRecordStopNotFoundError);
    expect(f.map.size).toBe(1);
    expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it('admits an independently verified original run without a stop as typed core-recovery fallback, never cleanup', async () => {
    const f = await fixture();
    const profile = await savedProfile();
    const run = await createAutoSellRun(
      f.reminder.runId,
      profile,
      [{ address: profileWallet.address, revision: 1, archived: false }],
      '2026-10-25T00:00:01.000Z',
    );
    await expect(
      recover(f.reminder, signal(), {
        ...f.options,
        fetcher: vi.fn(async () => json({ ...f.body, stop: null, run })),
      }),
    ).rejects.toBeInstanceOf(AutoSellRunRecordStopNotFoundError);
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    expect(f.map.size).toBe(1);
    run.sha256 = 'f'.repeat(64);
    const bad = recover(f.reminder, signal(), {
      ...f.options,
      fetcher: vi.fn(async () => json({ ...f.body, stop: null, run })),
    });
    await expect(bad).rejects.not.toBeInstanceOf(
      AutoSellRunRecordStopNotFoundError,
    );
  });
  it.each([404, 202, 408, 409, 401, 500])(
    'never clears on status %s',
    async (status) => {
      const f = await fixture();
      await expect(
        recover(f.reminder, signal(), {
          ...f.options,
          fetcher: vi.fn(async () => json({ error: 'private' }, status)),
        }),
      ).rejects.toThrow('could not be verified');
      expect(f.map.size).toBe(1);
    },
  );
  it.each([
    'owner',
    'run',
    'project',
    'profile',
    'profile-hash',
    'request-hash',
    'authority',
    'extra',
    'null-run-required',
    'found-run-required',
  ])('rejects %s terminal mismatch', async (kind) => {
    const f = await fixture();
    const body: Record<string, unknown> = structuredClone(f.body);
    const receipt = body.stop as Record<string, unknown>;
    if (kind === 'owner') body.ownerScope = 'a'.repeat(64);
    if (kind === 'run') receipt.runId = '40000000-0000-4000-8000-000000000001';
    if (kind === 'project')
      receipt.projectId = '40000000-0000-4000-8000-000000000001';
    if (kind === 'profile')
      receipt.profileSaveId = '40000000-0000-4000-8000-000000000001';
    if (kind === 'profile-hash') receipt.profileSha256 = 'e'.repeat(64);
    if (kind === 'request-hash') receipt.requestSha256 = 'e'.repeat(64);
    if (kind === 'authority') receipt.executionAllowed = true;
    if (kind === 'extra') body.transferCancelled = true;
    if (kind === 'null-run-required') body.run = {};
    if (kind === 'found-run-required') {
      receipt.status = 'record-found';
      receipt.runSha256 = 'e'.repeat(64);
    }
    await expect(
      recover(f.reminder, signal(), {
        ...f.options,
        fetcher: vi.fn(async () => json(body)),
      }),
    ).rejects.toThrow();
    expect(f.map.size).toBe(1);
  });
  it('keeps a newer cross-tab marker even when original stop is confirmed', async () => {
    const f = await fixture();
    const newer = {
      ...f.reminder,
      runId: '50000000-0000-4000-8000-000000000001',
    };
    f.map.set(f.key, JSON.stringify(newer));
    expect(
      (await recover(f.reminder, signal(), f.options)).reminderRetained,
    ).toBe(true);
    expect(f.map.get(f.key)).toBe(JSON.stringify(newer));
  });
  it('rejects a self-consistent terminal receipt for another original request', async () => {
    const f = await fixture();
    const foreign = {
      ...f.request,
      runId: '70000000-0000-4000-8000-000000000001',
    };
    const body = {
      ...f.body,
      stop: {
        ...f.receipt,
        runId: foreign.runId,
        requestSha256: await autoSellRunRecordStopRequestSha256(foreign),
      },
    };
    await expect(
      recover(f.reminder, signal(), {
        ...f.options,
        fetcher: vi.fn(async () => json(body)),
      }),
    ).rejects.toThrow();
    expect(f.map.size).toBe(1);
  });
  it('does not erase a marker when the exact-key lock is busy', async () => {
    const f = await fixture();
    const locks = {
      request: vi.fn(
        async (
          _key: string,
          _options: unknown,
          callback: (lock: null) => unknown,
        ) => callback(null),
      ) as unknown as LockManager['request'],
    };
    expect(
      (await recover(f.reminder, signal(), { ...f.options, locks }))
        .reminderRetained,
    ).toBe(true);
    expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it('returns confirmed but retained when no lock or failed clear', async () => {
    const f = await fixture();
    expect(
      (await recover(f.reminder, signal(), { ...f.options, locks: null }))
        .reminderRetained,
    ).toBe(true);
    f.storage.removeItem.mockImplementation(() => {
      throw Error('denied');
    });
    expect(
      (await recover(f.reminder, signal(), f.options)).reminderRetained,
    ).toBe(true);
    expect(f.map.size).toBe(1);
  });
  it('refuses hidden/prototype/accessor original input without calling getters', async () => {
    const f = await fixture();
    const getter = vi.fn(() => f.reminder.runId);
    Object.defineProperty(f.reminder, 'runId', {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      stop({ reminder: f.reminder, approved: true }, signal(), f.options),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('captures original reminder before asynchronous caller changes', async () => {
    const f = await fixture();
    const input = { ...f.reminder };
    const pending = recover(input, signal(), f.options);
    input.runId = '60000000-0000-4000-8000-000000000001';
    expect((await pending).stop.runId).toBe(f.reminder.runId);
  });
  it('holds marker after abort and ignores a late successful stop response', async () => {
    const f = await fixture();
    let finish!: (r: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = stop(
      { reminder: f.reminder, approved: true },
      controller.signal,
      { ...f.options, fetcher },
    );
    controller.abort();
    await expect(pending).rejects.toThrow('Waiting stopped');
    finish(json(f.body));
    await Promise.resolve();
    expect(f.map.size).toBe(1);
    expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(['html', 'broken-json', 'network'])(
    'sanitizes %s without leaking body or URL',
    async (kind) => {
      const f = await fixture();
      const fetcher = vi.fn(async () => {
        if (kind === 'network') throw Error('https://private.invalid/key');
        return new Response(kind === 'html' ? '<h1>private</h1>' : '{private', {
          headers: {
            'content-type': kind === 'html' ? 'text/html' : 'application/json',
          },
        });
      });
      await expect(
        recover(f.reminder, signal(), { ...f.options, fetcher }),
      ).rejects.toThrow('could not be verified');
      expect(f.map.size).toBe(1);
    },
  );
});
