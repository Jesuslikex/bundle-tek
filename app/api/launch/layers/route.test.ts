import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  context: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  db: {},
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
vi.mock('@/lib/launch-layer-service', async (original) => ({
  ...(await original<typeof import('@/lib/launch-layer-service')>()),
  readLaunchLayerContext: state.context,
  readOwnedLaunchLayerPlan: state.read,
  saveOwnedLaunchLayerPlan: state.save,
}));
import { GET, POST } from './route';
import { LaunchLayerError } from '@/lib/launch-layer-service';
import { launchLayerFixture } from '@/test/launch-layer-fixture';
const get = (query: string) =>
  GET(new Request('https://bundle.test/api/launch/layers?' + query));
const request = (
  body: BodyInit | null = JSON.stringify(launchLayerFixture().input),
  headers: Record<string, string> = {
    origin: 'https://bundle.test',
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
) =>
  new Request('https://bundle.test/api/launch/layers', {
    method: 'POST',
    body,
    headers,
    signal,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
beforeEach(() => {
  state.user = { userId: 'alice' };
  state.context.mockReset().mockResolvedValue({ fundingAllowed: false });
  state.read.mockReset().mockResolvedValue(null);
  state.save.mockReset().mockResolvedValue({
    planningOnly: true,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
});
it('requires authentication before context, history or save access', async () => {
  state.user = null;
  expect((await get('projectId=source')).status).toBe(401);
  expect((await POST(request())).status).toBe(401);
  expect(state.context).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  expect(state.read).not.toHaveBeenCalled();
});
it('forwards only the authenticated owner and selected saved context without caching', async () => {
  const f = launchLayerFixture(),
    r = await get('context=' + encodeURIComponent(JSON.stringify(f.selection)));
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(state.context).toHaveBeenCalledWith(state.db, 'alice', f.selection);
  await get('projectId=source&id=record');
  expect(state.read).toHaveBeenCalledWith(
    state.db,
    'alice',
    'source',
    'record',
  );
});
it.each([
  '',
  'projectId=a&projectId=b',
  'projectId=a&owner=b',
  'id=x',
  'context=%7B',
  'projectId=a&id=b&extra=c',
])('refuses malformed or ambiguous selection %s', async (query) => {
  expect((await get(query)).status).toBe(400);
  expect(state.context).not.toHaveBeenCalled();
  expect(state.read).not.toHaveBeenCalled();
});
it('caps a context selection before decoding', async () => {
  expect(
    (await get('context=' + encodeURIComponent(' '.repeat(2049)))).status,
  ).toBe(413);
  expect(state.context).not.toHaveBeenCalled();
});
it('requires exact same origin and JSON before saving a plan', async () => {
  expect(
    (await POST(request(undefined, { 'content-type': 'application/json' })))
      .status,
  ).toBe(403);
  expect(
    (
      await POST(
        request(undefined, {
          origin: 'https://foreign.test',
          'content-type': 'application/json',
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await POST(
        request(undefined, {
          origin: 'https://bundle.test',
          'content-type': 'application/json-bogus',
        }),
      )
    ).status,
  ).toBe(415);
  expect((await POST(request('{'))).status).toBe(400);
  expect(state.save).not.toHaveBeenCalled();
});
it('bounds streamed request bytes without relying on a content-length claim', async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(150000));
    },
  });
  expect(
    (
      await POST(
        request(stream, {
          origin: 'https://bundle.test',
          'content-type': 'application/json',
          'content-length': '10',
        }),
      )
    ).status,
  ).toBe(413);
  expect(state.save).not.toHaveBeenCalled();
});
it('saves only planner inputs with the authenticated owner and propagates cancellation', async () => {
  const f = launchLayerFixture(),
    req = request(JSON.stringify(f.input)),
    r = await POST(req);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(state.save).toHaveBeenCalledWith(
    state.db,
    'alice',
    f.input,
    Date.now,
    req.signal,
  );
  const c = new AbortController();
  c.abort();
  state.save.mockClear();
  expect((await POST(request(undefined, undefined, c.signal))).status).toBe(
    408,
  );
  expect(state.save).not.toHaveBeenCalled();
});
it('keeps storage errors safe and domain conflict reasons actionable', async () => {
  state.save.mockRejectedValue(new Error('private-database-url'));
  let r = await POST(request());
  expect(r.status).toBe(503);
  expect(JSON.stringify(await r.json())).not.toContain('private-database');
  state.save.mockRejectedValue(
    new LaunchLayerError('Reload the current selected wallet.', 409),
  );
  r = await POST(request());
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({
    error: 'Reload the current selected wallet.',
  });
});
