// @vitest-environment jsdom
import { expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AccountLaunchActivitySummary,
  AccountLaunchActivityPanel,
} from './account-launch-activity';
import type { AccountLaunchActivity } from '@/lib/account-launch-activity';

const activity: AccountLaunchActivity = {
  observedAt: '2026-10-18T10:00:00.000Z',
  savedGroups: 1,
  finalizedGroups: 1,
  awaitingReview: 0,
  finalizationEvidenceMissing: 0,
  recent: [
    {
      id: '00000001-0000-4000-8000-000000000000',
      mint: '11111111111111111111111111111111',
      state: 'finalized',
      createdAt: '2026-10-18T09:00:00.000Z',
      settlementState: 'finalized',
      settledAt: '2026-10-18T09:30:00.000Z',
    },
  ],
};

it('shows launch group states and keeps methodology details collapsed', () => {
  const html = renderToStaticMarkup(
    <AccountLaunchActivitySummary value={activity} />,
  );
  expect(html).toContain('aria-label="Launch activity"');
  expect(html).toContain('Saved groups');
  expect(html).toContain('Finalized groups');
  expect(html).toContain('Awaiting review');
  expect(html).toContain('Finalized group');
  expect(html).toContain('<details>');
  expect(html).toContain('does not calculate launch profit');
  expect(html).not.toContain('signature');
});

it('gives a useful empty state without inventing launch results', () => {
  const html = renderToStaticMarkup(
    <AccountLaunchActivitySummary
      value={{
        ...activity,
        savedGroups: 0,
        finalizedGroups: 0,
        awaitingReview: 0,
        recent: [],
      }}
    />,
  );
  expect(html).toContain('No saved launch groups yet.');
  expect(html).toContain('does not calculate launch profit');
});

let host: HTMLDivElement, root: Root;
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const mount = async () => {
  await act(async () => root.render(<AccountLaunchActivityPanel />));
};
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find(
    (el) => el.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
};

it('recovers from a non-JSON server error and refreshes without retaining stale counts', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response('server unavailable', { status: 503 }),
  );
  await mount();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'No partial counts',
  );
  fetchMock.mockResolvedValueOnce(Response.json(activity));
  await click('Try again');
  expect(host.textContent).toContain('Finalized groups');
  expect(host.querySelector('details')?.open).toBe(false);
  fetchMock.mockResolvedValueOnce(
    new Response('server unavailable', { status: 503 }),
  );
  await click('Refresh launch activity');
  expect(host.textContent).not.toContain('Finalized groups');
  expect(
    fetchMock.mock.calls.every(
      ([url, options]) =>
        url === '/api/account-launch-activity' &&
        options?.cache === 'no-store' &&
        !options?.method,
    ),
  ).toBe(true);
});

it('offers sign-in when authentication expires even with a non-JSON response', async () => {
  fetchMock.mockResolvedValueOnce(new Response('expired', { status: 401 }));
  await mount();
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/sign-in');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('allows retry after a hung request and ignores a late stale response', async () => {
  vi.useFakeTimers();
  let resolve!: (value: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  await mount();
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'took too long',
  );
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  fetchMock.mockResolvedValueOnce(
    Response.json({
      ...activity,
      savedGroups: 0,
      finalizedGroups: 0,
      recent: [],
    }),
  );
  await click('Try again');
  await act(async () => resolve(Response.json(activity)));
  expect(host.textContent).toContain('No saved launch groups yet.');
  expect(host.querySelector('ol')).toBeNull();
});

it('aborts the active read on unmount', async () => {
  fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
  await mount();
  const signal = fetchMock.mock.calls[0][1]?.signal;
  await act(async () => root.unmount());
  expect(signal?.aborted).toBe(true);
  root = createRoot(host);
});

it('mounts passive cross-venue discovery without changing the Pump activity request', async () => {
  fetchMock.mockResolvedValueOnce(Response.json(activity));
  await mount();
  expect(
    host.querySelector('[aria-label="Saved launch recovery"]'),
  ).not.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/account-launch-activity');
});
