import { afterEach, expect, it, vi } from 'vitest';
import {
  strategyDraftRequest,
  readSavedStrategyDraft,
} from './strategy-draft-client';
import { planStrategySession } from './strategy-session-plan';
import {
  strategyContext,
  strategyInput,
  strategyProject,
} from '../test/strategy-session-fixture';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each([401, 200])(
  'sanitizes non-JSON/auth responses (%s)',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('private upstream body', { status })),
    );
    await expect(
      strategyDraftRequest(
        '/api/test',
        undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow(status === 401 ? 'Sign in' : 'unavailable');
  },
);
it('refuses changed authority in a nominally successful response', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ planningOnly: true, executionAllowed: true }),
      ),
  );
  await expect(
    strategyDraftRequest('/api/test', undefined, new AbortController().signal),
  ).rejects.toThrow('authority');
});
it.each(['drafts', 'capacity'] as const)(
  'bounds a stalled %s response body even when the transport ignores abort',
  async (subject) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () => new Promise(() => {}),
      }),
    );
    const result = expect(
      strategyDraftRequest(
        '/api/test',
        { action: 'save' },
        new AbortController().signal,
        subject,
      ),
    ).rejects.toThrow('outcome not confirmed');
    await vi.advanceTimersByTimeAsync(15000);
    await result;
  },
);
it('cancels pending IO without accepting late success', async () => {
  let resolve!: (v: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  );
  const controller = new AbortController();
  const result = expect(
    strategyDraftRequest('/api/test', undefined, controller.signal),
  ).rejects.toThrow('cancelled');
  controller.abort();
  await result;
  resolve(Response.json({ planningOnly: true, executionAllowed: false }));
});
it('rejects a saved draft in another project or with altered authority', () => {
  const draft = {
    id: '00000000-0000-4000-8000-000000000010',
    revision: 1,
    archived: false,
    createdAt: '2026-10-18T12:00:00.000Z',
    plan: planStrategySession(strategyInput(), strategyContext()),
  };
  expect(() => readSavedStrategyDraft(draft, 'other')).toThrow(
    'different project',
  );
  Object.assign(draft.plan, { signingAllowed: true });
  expect(() => readSavedStrategyDraft(draft, strategyProject)).toThrow();
});
