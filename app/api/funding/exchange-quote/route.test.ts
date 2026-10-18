import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  preview: vi.fn(),
  read: vi.fn(),
  db: {},
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
vi.mock('@/lib/exchange-funding-quote', async (original) => ({
  ...(await original<typeof import('@/lib/exchange-funding-quote')>()),
  previewOwnedExchangeFunding: state.preview,
  readOwnedExchangeFundingQuote: state.read,
}));
import { GET, POST } from './route';
import { ExchangeFundingError } from '@/lib/exchange-funding-quote';
const value = {
  planId: 'draft',
  revision: 1,
  funderRevision: 2,
  minimumPayoutLamports: '1000000000',
};
const request = (
  body = JSON.stringify(value),
  headers: Record<string, string> = {
    origin: 'https://bundle.test',
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
) =>
  new Request('https://bundle.test/api/funding/exchange-quote', {
    method: 'POST',
    headers,
    body,
    signal,
  });
beforeEach(() => {
  state.user = { userId: 'alice' };
  state.preview.mockReset().mockResolvedValue({ signingAllowed: false });
  state.read
    .mockReset()
    .mockResolvedValue({ durableReview: true, signingAllowed: false });
});
it('requires authentication and exact same origin', async () => {
  state.user = null;
  expect((await POST(request())).status).toBe(401);
  state.user = { userId: 'alice' };
  const origins: Record<string, string>[] = [
    { 'content-type': 'application/json' },
    { origin: 'https://other.test', 'content-type': 'application/json' },
  ];
  for (const headers of origins)
    expect((await POST(request(undefined, headers))).status).toBe(403);
  expect(state.preview).not.toHaveBeenCalled();
});
it('checks content type, JSON, size and exact selection before service access', async () => {
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
  expect(
    (await POST(request(JSON.stringify({ ...value, signingAllowed: true }))))
      .status,
  ).toBe(400);
  expect(
    (
      await POST(
        request(JSON.stringify({ ...value, minimumPayoutLamports: '1.1' })),
      )
    ).status,
  ).toBe(400);
  expect((await POST(request(' '.repeat(2049)))).status).toBe(413);
  expect(state.preview).not.toHaveBeenCalled();
});
it('passes only the authenticated owner and validated selection; responses are not cached', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ quote: { signingAllowed: false } });
  expect(state.preview).toHaveBeenCalledWith(
    state.db,
    'alice',
    value,
    expect.any(AbortSignal),
    expect.objectContaining({ enabled: false }),
  );
});
it('preserves typed refusal status and hides unexpected error text', async () => {
  state.preview.mockRejectedValue(
    new ExchangeFundingError('Reload saved draft.', 409),
  );
  expect((await POST(request())).status).toBe(409);
  state.preview.mockRejectedValue(new Error('secret upstream data'));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain('secret');
});
it('reports cancellation without presenting a fresh quote', async () => {
  const controller = new AbortController();
  controller.abort();
  state.preview.mockRejectedValue(new Error('abort'));
  expect(
    (await POST(request(undefined, undefined, controller.signal))).status,
  ).toBe(408);
});
it('reads historical reviews only for the authenticated owner and returns no-store', async () => {
  state.user = null;
  expect(
    (
      await GET(
        new Request(
          'https://bundle.test/api/funding/exchange-quote?id=example',
        ),
      )
    ).status,
  ).toBe(401);
  expect(state.read).not.toHaveBeenCalled();
  state.user = { userId: 'alice' };
  const response = await GET(
    new Request('https://bundle.test/api/funding/exchange-quote?id=example'),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(state.read).toHaveBeenCalledWith(state.db, 'alice', 'example');
  expect(state.preview).not.toHaveBeenCalled();
});
