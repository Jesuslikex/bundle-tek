import { validateIntent as validate } from './intent';
import { it, expect, vi } from 'vitest';
import { handlePons } from './api';
import { PonsStore } from './store';
import { sqliteD1 } from './testing';
import { sample } from './testing';
it('authenticates before parsing, locks public default, bounds JSON and persists failed simulation', async () => {
  const store = new PonsStore(sqliteD1());
  await store.ensure();
  const deps = {
    owner: async () => 'alice',
    enabled: true,
    store,
    simulate: vi.fn(async () => {
      throw Error('RPC unavailable secret detail');
    }),
  };
  const req = (body: unknown) =>
    new Request('https://app.test/api/pons/jobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'api-test-key',
      },
      body: JSON.stringify(body),
    });
  expect(
    (
      await handlePons(req(sample), 'create', undefined, {
        ...deps,
        owner: async () => null,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await handlePons(req(sample), 'create', undefined, {
        ...deps,
        enabled: false,
      })
    ).status,
  ).toBe(423);
  expect(
    (
      await handlePons(
        req({ padding: 'x'.repeat(17000) }),
        'create',
        undefined,
        deps,
      )
    ).status,
  ).toBe(413);
  const created = await handlePons(req(sample), 'create', undefined, deps);
  expect(created.status).toBe(201);
  const { job } = (await created.json()) as { job: { id: string } };
  const failed = await handlePons(
    req({ revision: 0 }),
    'simulate',
    job.id,
    deps,
  );
  expect(failed.status).toBe(200);
  const persisted = await store.get('alice', job.id);
  expect(persisted.state).toBe('simulation_failed');
  expect(persisted.result).not.toContain('secret detail');
  expect(JSON.parse(persisted.result!).error).toBe('SIMULATION_RPC_FAILED');
  expect(
    (
      await handlePons(new Request('https://app.test'), 'get', job.id, {
        ...deps,
        owner: async () => 'bob',
      })
    ).status,
  ).toBe(404);
});

it('rejects cross-origin mutations, malformed UTF8, unknown fields and stale revisions', async () => {
  const store = new PonsStore(sqliteD1());
  await store.ensure();
  const deps = {
    owner: async () => 'a',
    enabled: true,
    store,
    simulate: vi.fn(async () => ({ ok: true })),
  };
  const make = (body: string, origin?: string) =>
    new Request('https://app.test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'safety-key',
        ...(origin ? { origin } : {}),
      },
      body,
    });
  expect(
    (
      await handlePons(
        make(JSON.stringify(sample), 'https://evil.test'),
        'create',
        undefined,
        deps,
      )
    ).status,
  ).toBe(403);
  expect((await handlePons(make('{'), 'create', undefined, deps)).status).toBe(
    400,
  );
  expect(
    (
      await handlePons(
        make(JSON.stringify({ ...sample, allocations: [] })),
        'create',
        undefined,
        deps,
      )
    ).status,
  ).toBe(400);
  const res = await handlePons(
    make(JSON.stringify(sample)),
    'create',
    undefined,
    deps,
  );
  const { job } = (await res.json()) as { job: { id: string } };
  expect(
    (await handlePons(make(' {"revision":9}'), 'simulate', job.id, deps))
      .status,
  ).toBe(409);
  expect(deps.simulate).not.toHaveBeenCalled();
});
it('never hands out an expired unsigned transaction as usable', async () => {
  const store = new PonsStore(sqliteD1());
  await store.ensure();
  const deps = {
    owner: async () => 'a',
    enabled: true,
    store,
    simulate: vi.fn(async () => ({
      ok: true,
      expiresAt: 1,
      unsignedTransaction: { data: '0x1234' },
    })),
  };
  const j = await store.create('a', 'expired-key', validate(sample));
  const claim = await store.claim('a', j.id, 0);
  await store.finish('a', j.id, claim.revision, claim.lease_token!, {
    ok: true,
    expiresAt: 1,
    unsignedTransaction: { data: '0x1234' },
  });
  const res = await handlePons(
    new Request('https://app.test'),
    'get',
    j.id,
    deps,
  );
  const out = (await res.json()) as {
    job: { handoff: { usable: boolean; reason: string } };
  };
  expect(out.job.handoff).toEqual({
    usable: false,
    reason: 'SIMULATION_EXPIRED',
  });
});

it('times out a stalled request body instead of holding an unbounded request', async () => {
  vi.useFakeTimers();
  try {
    const s = new PonsStore(sqliteD1());
    await s.ensure();
    const request = new Request('https://app.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream({ start() {} }),
      duplex: 'half',
    } as RequestInit);
    const promise = handlePons(request, 'create', undefined, {
      owner: async () => 'a',
      enabled: true,
      store: s,
      simulate: async () => ({ ok: true }),
    });
    await vi.advanceTimersByTimeAsync(5001);
    const result = await Promise.race([promise, Promise.resolve(null)]);
    expect(result?.status).toBe(408);
  } finally {
    vi.useRealTimers();
  }
});

it('persists overall simulation timeout while the durable lease is still valid', async () => {
  vi.useFakeTimers();
  try {
    const s = new PonsStore(sqliteD1());
    await s.ensure();
    const j = await s.create('a', 'timeout-key', validate(sample));
    const request = new Request('https://app.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"revision":0}',
    });
    const promise = handlePons(request, 'simulate', j.id, {
      owner: async () => 'a',
      enabled: true,
      store: s,
      simulate: async () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(90001);
    const res = await promise;
    expect(res.status).toBe(200);
    const saved = await s.get('a', j.id);
    expect(saved.state).toBe('simulation_failed');
    expect(JSON.parse(saved.result!).error).toBe('SIMULATION_TIMEOUT');
  } finally {
    vi.useRealTimers();
  }
});

it('bounds cleanup of a stalled rejected upload and cancels without waiting on the source', async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const pull = vi.fn();
    const request = new Request('https://app.test', {
      method: 'POST',
      body: new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
      duplex: 'half',
    } as RequestInit);
    const pending = handlePons(request, 'create', undefined, {
      owner: async () => null,
      enabled: true,
      store: async () => {
        throw Error('must not access store');
      },
      simulate: async () => ({ ok: true }),
    });
    await vi.advanceTimersByTimeAsync(5001);
    const result = await pending;
    expect(result.status).toBe(401);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('finishes a small rejected upload before cancelling its stream', async () => {
  const pull = vi.fn(
    (controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode('rejected upload'));
      controller.close();
    },
  );
  const request = new Request('https://app.test', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.test',
    },
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: 'half',
  } as RequestInit);
  const response = await handlePons(request, 'create', undefined, {
    owner: async () => 'a',
    enabled: true,
    store: async () => {
      throw Error('must not access store');
    },
    simulate: async () => ({ ok: true }),
  });
  expect(response.status).toBe(403);
  expect(pull).toHaveBeenCalledOnce();
  expect(request.bodyUsed).toBe(true);
});

it.each([
  ['auth', 401],
  ['gate', 423],
  ['origin', 403],
  ['id', 400],
  ['type', 415],
  ['length', 413],
  ['store', 503],
] as const)(
  'cleans up early %s rejection without store mutation',
  async (failure, status) => {
    const pull = vi.fn(
      (controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      },
    );
    const request = new Request('https://app.test', {
      method: 'POST',
      headers: {
        'content-type': failure === 'type' ? 'text/plain' : 'application/json',
        ...(failure === 'origin' ? { origin: 'https://evil.test' } : {}),
        ...(failure === 'length' ? { 'content-length': '20000' } : {}),
      },
      body: new ReadableStream({ pull }, { highWaterMark: 0 }),
      duplex: 'half',
    } as RequestInit);
    const store = new PonsStore(sqliteD1());
    const create = vi.spyOn(store, 'create');
    const response = await handlePons(
      request,
      failure === 'id' ? 'simulate' : 'create',
      undefined,
      {
        owner: async () => (failure === 'auth' ? null : 'a'),
        enabled: failure !== 'gate',
        store:
          failure === 'store'
            ? async () => {
                throw Error('store unavailable');
              }
            : store,
        simulate: async () => ({ ok: true }),
      },
    );
    expect(response.status).toBe(status);
    expect(pull).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  },
);

it.each([1024, 0])(
  'time-bounds rejected-body cleanup for an endless stream of %i-byte chunks',
  async (size) => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const pull = vi.fn(
        (controller: ReadableStreamDefaultController<Uint8Array>) => {
          controller.enqueue(new Uint8Array(size));
        },
      );
      const request = new Request('https://app.test', {
        method: 'POST',
        body: new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
        duplex: 'half',
      } as RequestInit);
      const pending = handlePons(request, 'create', undefined, {
        owner: async () => null,
        enabled: true,
        store: async () => {
          throw Error('must not access store');
        },
        simulate: async () => ({ ok: true }),
      });
      await vi.advanceTimersByTimeAsync(5001);
      const response = await pending;
      expect(response.status).toBe(401);
      expect(pull.mock.calls.length).toBeGreaterThanOrEqual(64);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  },
);

it('preserves the API error when rejected input fails during cleanup', async () => {
  const request = new Request('https://app.test', {
    method: 'POST',
    body: new ReadableStream(
      {
        pull() {
          throw Error('private input failure');
        },
      },
      { highWaterMark: 0 },
    ),
    duplex: 'half',
  } as RequestInit);
  const response = await handlePons(request, 'create', undefined, {
    owner: async () => null,
    enabled: true,
    store: async () => {
      throw Error('must not access store');
    },
    simulate: async () => ({ ok: true }),
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'AUTH_REQUIRED' });
});

it('drains a finite 100 KiB stream after the JSON size limit is exceeded', async () => {
  let chunks = 0;
  const pull = vi.fn(
    (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (chunks++ < 100) controller.enqueue(new Uint8Array(1024));
      else controller.close();
    },
  );
  const request = new Request('https://app.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: 'half',
  } as RequestInit);
  const response = await handlePons(request, 'create', undefined, {
    owner: async () => 'a',
    enabled: true,
    store: new PonsStore(sqliteD1()),
    simulate: async () => ({ ok: true }),
  });
  expect(response.status).toBe(413);
  expect(chunks).toBe(101);
  expect(request.body?.locked).toBe(false);
});
