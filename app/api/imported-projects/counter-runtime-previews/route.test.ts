import { beforeEach, expect, it, vi } from 'vitest';
import { counterPreviewUiFixture } from '@/test/counter-preview-ui-fixture';
const state = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  gate: true,
  preview: vi.fn(),
  writes: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({
  getD1: () => ({
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          state.writes(sql, values);
          return { meta: { changes: state.gate ? 1 : 0 } };
        },
      }),
    }),
  }),
}));
vi.mock('@/lib/counter-owned-preview', async (original) => ({
  ...(await original<typeof import('@/lib/counter-owned-preview')>()),
  previewOwnedCounterBuyRuntime: state.preview,
}));
import { POST } from './route';
import { CounterPreviewError } from '@/lib/counter-owned-preview';
const input = () => counterPreviewUiFixture().request;
function request(
  value: unknown = input(),
  headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: 'https://bundle.test',
  },
) {
  return new Request(
    'https://bundle.test/api/imported-projects/counter-runtime-previews',
    { method: 'POST', headers, body: JSON.stringify(value) },
  );
}
beforeEach(() => {
  state.user = { userId: 'alice' };
  state.gate = true;
  state.preview.mockReset();
  state.writes.mockReset();
  state.preview.mockResolvedValue({
    preview: counterPreviewUiFixture().preview,
    runtime: {
      format: 'counter-buy-runtime-evidence-v1',
      signingAllowed: false,
      executionAllowed: false,
    },
  });
});
it('requires signed-in same-origin JSON with no query before any gate or provider call', async () => {
  state.user = null;
  expect((await POST(request())).status).toBe(401);
  state.user = { userId: 'alice' };
  expect(
    (await POST(request(input(), { 'content-type': 'application/json' })))
      .status,
  ).toBe(403);
  expect(
    (
      await POST(
        request(input(), {
          'content-type': 'application/json',
          origin: 'https://other.test',
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await POST(
        request(input(), {
          'content-type': 'text/plain',
          origin: 'https://bundle.test',
        }),
      )
    ).status,
  ).toBe(415);
  const query = new Request(
    'https://bundle.test/api/imported-projects/counter-runtime-previews?sign=true',
    {
      method: 'POST',
      headers: {
        origin: 'https://bundle.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(input()),
    },
  );
  expect((await POST(query)).status).toBe(400);
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.preview).not.toHaveBeenCalled();
});
it('accepts only exact owned Counter request fields and rejects authority or endpoint injection', async () => {
  for (const extra of [
    { sign: true },
    { rpcUrl: 'https://private.invalid' },
    { transaction: 'not-accepted' },
    { budgetId: crypto.randomUUID() },
  ])
    expect((await POST(request({ ...input(), ...extra }))).status).toBe(400);
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.preview).not.toHaveBeenCalled();
});
it('runs one original-packet runtime read under the authenticated owner and returns no-store', async () => {
  const value = input(),
    r = await POST(request(value));
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(state.preview).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    'alice',
    value,
    expect.any(AbortSignal),
  );
  const result = await r.json();
  expect(result).toHaveProperty('preview');
  expect(result).toHaveProperty('runtime');
  expect(result).not.toHaveProperty('codeScans');
  expect(result).not.toHaveProperty('transaction');
  expect(state.writes).toHaveBeenCalledOnce();
  expect(state.writes.mock.calls[0][0]).toContain(
    'imported_token_project_gates',
  );
});
it('shares the existing15second gate and never retries provider refusal', async () => {
  state.gate = false;
  const gated = await POST(request());
  expect(gated.status).toBe(429);
  expect(gated.headers.get('retry-after')).toBe('15');
  expect(state.preview).not.toHaveBeenCalled();
  state.gate = true;
  state.preview.mockRejectedValueOnce(
    Error('https://secret-provider.invalid/api-key'),
  );
  const r = await POST(request());
  expect(r.status).toBe(502);
  expect(await r.text()).not.toContain('secret-provider');
  expect(state.preview).toHaveBeenCalledOnce();
});
it('preserves owned stale-context409 and prevents success after caller cancellation', async () => {
  state.preview.mockRejectedValueOnce(
    new CounterPreviewError('Counter context changed.', 409),
  );
  expect((await POST(request())).status).toBe(409);
  const c = new AbortController();
  state.preview.mockImplementationOnce(async () => {
    c.abort();
    return { preview: {}, runtime: {} };
  });
  const original = request();
  const r = new Request(original, { signal: c.signal });
  expect((await POST(r)).status).toBe(408);
});
it('counts UTF8 bytes and refuses invalid UTF8 without charging the gate', async () => {
  const make = (bytes: Uint8Array) =>
    new Request(
      'https://bundle.test/api/imported-projects/counter-runtime-previews',
      {
        method: 'POST',
        headers: {
          origin: 'https://bundle.test',
          'content-type': 'application/json',
        },
        body: new Uint8Array(bytes).buffer,
      },
    );
  expect(
    (
      await POST(
        make(new TextEncoder().encode(JSON.stringify('é'.repeat(1100)))),
      )
    ).status,
  ).toBe(413);
  expect((await POST(make(new Uint8Array([123, 255, 125])))).status).toBe(400);
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.preview).not.toHaveBeenCalled();
});
it('cancels an interrupted streamed body without provider work or a rate charge', async () => {
  const c = new AbortController(),
    cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel,
  });
  const r = new Request(
    'https://bundle.test/api/imported-projects/counter-runtime-previews',
    {
      method: 'POST',
      headers: {
        origin: 'https://bundle.test',
        'content-type': 'application/json',
      },
      body: stream,
      duplex: 'half',
      signal: c.signal,
    } as RequestInit,
  );
  const pending = POST(r);
  await Promise.resolve();
  await Promise.resolve();
  c.abort();
  expect((await pending).status).toBe(408);
  expect(cancel).toHaveBeenCalledOnce();
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.preview).not.toHaveBeenCalled();
});
