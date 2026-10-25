// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchRecoveryDiscoveryPanel } from './launch-recovery-discovery';
import { RecoveryProjectNavigationProvider } from './recovery-project-navigation';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { DEFAULT_VENUE_OPTIONS, EMPTY_IDENTITY } from '@/lib/workspace-project';
import {
  encodeLaunchRecoveryCursor,
  type LaunchRecoveryDiscovery,
  type LaunchRecoveryItem,
} from '@/lib/launch-recovery-discovery';

const item: LaunchRecoveryItem = {
  source: 'meteora-dbc',
  reviewKind: 'single',
  id: 'original-record',
  projectId: 'original-project',
  projectName: 'Original project',
  mint: '11111111111111111111111111111111',
  state: 'submitted',
  createdAt: '2026-10-18T09:00:00.000Z',
  expiresAt: '2026-10-18T09:05:00.000Z',
  hasSignature: true,
  hasReceipt: true,
};
const page: LaunchRecoveryDiscovery = {
  format: 'launch-recovery-discovery-v1',
  scope: 'saved-solana-nonterminal',
  observedAt: '2026-10-24T09:00:00.000Z',
  cursor: null,
  nextCursor: null,
  items: [item],
  signingAllowed: false,
  executionAllowed: false,
  receiptVerified: false,
};
let host: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  fetchMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
  });
});
async function mount() {
  await act(async () => root.render(<LaunchRecoveryDiscoveryPanel />));
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
it('is passive on mount and shows original references and conservative evidence after a manual GET', async () => {
  await mount();
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(Response.json(page));
  await click('Find saved launch recovery');
  expect(fetchMock).toHaveBeenCalledWith('/api/account-launch-recoveries', {
    cache: 'no-store',
    signal: expect.any(AbortSignal),
  });
  const text = host.textContent!;
  for (const expected of [
    'Outcome unresolved',
    'Do not resend',
    'not permission to retry',
    'Stored signature: present',
    'Stored receipt: present',
    'Neither is verified',
    'at most 20',
    'not a complete launch inventory',
    item.projectId,
    item.id,
    item.mint,
  ])
    expect(text).toContain(expected);
  expect(host.querySelector('pre')?.textContent).toContain(
    'Venue: meteora-dbc\nReview kind: single',
  );
  expect(host.querySelectorAll('a')).toHaveLength(0);
  expect(
    [...host.querySelectorAll('button')].some((b) =>
      /sign|send|restore|renew/i.test(b.textContent!),
    ),
  ).toBe(false);
});
it('replaces pages using the exact cursor, clears old data while loading, and supports newest reset', async () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    ...item,
    id: `original-record-${String(99 - index).padStart(2, '0')}`,
  }));
  const nextCursor = encodeLaunchRecoveryCursor(items.at(-1)!);
  await mount();
  fetchMock.mockResolvedValueOnce(
    Response.json({ ...page, items, nextCursor }),
  );
  await click('Find saved launch recovery');
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click('Older saved records');
  expect(host.textContent).not.toContain(item.id);
  expect(fetchMock.mock.calls[1][0]).toBe(
    `/api/account-launch-recoveries?cursor=${encodeURIComponent(nextCursor)}`,
  );
  await act(async () =>
    finish(Response.json({ ...page, cursor: nextCursor, items: [] })),
  );
  expect(host.textContent).toContain('No matching saved records on this page');
  fetchMock.mockResolvedValueOnce(Response.json(page));
  await click('Load newest saved records');
  expect(fetchMock.mock.calls[2][0]).toBe('/api/account-launch-recoveries');
});
it('clears prior data and exposes sign-in and manual retry for non-JSON 401', async () => {
  await mount();
  fetchMock.mockResolvedValueOnce(Response.json(page));
  await click('Find saved launch recovery');
  fetchMock.mockResolvedValueOnce(
    new Response('<html>expired</html>', { status: 401 }),
  );
  await click('Load newest saved records');
  expect(host.textContent).not.toContain(item.id);
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/sign-in');
  fetchMock.mockResolvedValueOnce(Response.json(page));
  await click('Try recovery read again');
  expect(host.querySelector('a')).toBeNull();
  expect(host.textContent).toContain(item.id);
});
it('fails closed on malformed or wrong-cursor responses without raw parser text', async () => {
  await mount();
  fetchMock.mockResolvedValueOnce(
    new Response('<html>secret raw page</html>', { status: 502 }),
  );
  await click('Find saved launch recovery');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'unavailable',
  );
  expect(host.textContent).not.toContain('secret raw page');
  fetchMock.mockResolvedValueOnce(
    Response.json({ ...page, signingAllowed: true }),
  );
  await click('Try recovery read again');
  expect(host.textContent).not.toContain(item.id);
  fetchMock.mockResolvedValueOnce(
    Response.json({ ...page, cursor: encodeLaunchRecoveryCursor(item) }),
  );
  await click('Try recovery read again');
  expect(host.textContent).not.toContain(item.id);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'unavailable',
  );
});
it('times out while reading a response body, releases the read controls and cancels the body', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  fetchMock.mockResolvedValueOnce(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await mount();
  await click('Find saved launch recovery');
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(host.textContent).toContain('took too long');
  expect(cancel).toHaveBeenCalled();
  expect(
    [...host.querySelectorAll('button')].some((button) => button.disabled),
  ).toBe(false);
});
it('ends a hung read after 15 seconds, aborts it, and ignores late success after retry', async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await click('Find saved launch recovery');
  const signal = fetchMock.mock.calls[0][1]!.signal!;
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(signal.aborted).toBe(true);
  expect(host.textContent).toContain('took too long');
  fetchMock.mockResolvedValueOnce(Response.json({ ...page, items: [] }));
  await click('Try recovery read again');
  await act(async () => finish(Response.json(page)));
  expect(host.textContent).not.toContain(item.id);
  expect(host.textContent).toContain('No matching saved records');
});
it('cancels only the read and refuses stale completion, including after unmount', async () => {
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await click('Find saved launch recovery');
  const signal = fetchMock.mock.calls[0][1]!.signal!;
  await click('Cancel read');
  expect(signal.aborted).toBe(true);
  await act(async () => finish(Response.json(page)));
  expect(host.textContent).not.toContain(item.id);
  fetchMock.mockImplementationOnce(() => new Promise(() => {}));
  await click('Try recovery read again');
  const nextSignal = fetchMock.mock.calls[1][1]!.signal!;
  await act(async () => root.unmount());
  expect(nextSignal.aborted).toBe(true);
  root = createRoot(host);
});
it('retains a selectable full reference when copying fails and ignores stale clipboard completion', async () => {
  let finish!: () => void;
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(Error('unavailable'))
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  await mount();
  fetchMock.mockResolvedValueOnce(Response.json(page));
  await click('Find saved launch recovery');
  const originalReference = [...host.querySelectorAll('details')].find(
    (d) =>
      d.querySelector('summary')?.textContent === 'Original recovery reference',
  )!;
  await act(async () => {
    originalReference.open = true;
  });
  await click('Copy recovery reference');
  expect(host.textContent).toContain('copy it manually');
  expect(writeText.mock.calls[0][0]).toBe(
    `Venue: meteora-dbc\nReview kind: single\nProject ID: ${item.projectId}\nMint: ${item.mint}\nRecord ID: ${item.id}`,
  );
  await click('Copy recovery reference');
  fetchMock.mockResolvedValueOnce(Response.json({ ...page, items: [] }));
  await click('Load newest saved records');
  await act(async () => finish());
  expect(host.textContent).not.toContain('Reference copied');
});

it('warns unresolved when an old review still has stored signature evidence', async () => {
  fetchMock.mockResolvedValue(
    Response.json({ ...page, items: [{ ...item, state: 'review' }] }),
  );
  await mount();
  await click('Find saved launch recovery');
  expect(host.textContent).toContain('Outcome unresolved');
  expect(host.textContent).not.toContain('Saved review state only');
});

it('opens only the requested current saved project through the supplied workspace guard', async () => {
  const project = {
    id: item.projectId,
    archived: false,
    updatedAt: '2026-10-24T00:00:00.000Z',
    plan: { ...DEFAULT_LAUNCH_PLAN },
    identity: { ...EMPTY_IDENTITY },
    options: { ...DEFAULT_VENUE_OPTIONS },
  };
  let guardedProject: unknown = null;
  fetchMock.mockImplementation(async (url) => {
    if (url === '/api/account-launch-recoveries') return Response.json(page);
    if (url === '/api/projects/' + item.projectId)
      return Response.json({ project });
    throw Error('Unexpected read');
  });
  await act(async () =>
    root.render(
      <RecoveryProjectNavigationProvider
        onOpen={(p) => {
          guardedProject = p;
        }}
      >
        <LaunchRecoveryDiscoveryPanel />
      </RecoveryProjectNavigationProvider>,
    ),
  );
  expect(fetchMock).not.toHaveBeenCalled();
  await click('Find saved launch recovery');
  expect(guardedProject).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await click('Open current saved project');
  expect(guardedProject).toMatchObject({ id: item.projectId, archived: false });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [, init] of fetchMock.mock.calls)
    expect(init?.method ?? 'GET').toBe('GET');
  expect(host.textContent).toContain('original review');
  expect(host.querySelector('input[type="password"]')).toBeNull();
});
it('does not expose a project shortcut when the protected navigation wiring is absent', async () => {
  fetchMock.mockResolvedValue(Response.json(page));
  await mount();
  await click('Find saved launch recovery');
  expect(
    [...host.querySelectorAll('button')].some(
      (button) => button.textContent === 'Open current saved project',
    ),
  ).toBe(false);
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('inspects the original saved row without a current project or navigation provider', async () => {
  const reference = {
    source: item.source,
    reviewKind: item.reviewKind,
    id: item.id,
    projectId: item.projectId,
    mint: item.mint,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
  const inspection = {
    format: 'launch-recovery-inspection-v1',
    reference,
    inspectedAt: '2026-10-24T00:00:00.000Z',
    recordedState: 'finalized',
    name: 'Original retained token',
    symbol: 'OLD',
    payer: item.mint,
    payerRevision: null,
    projectUpdatedAt: null,
    quoteMint: null,
    hashes: [{ kind: 'packet', index: null, sha256: 'a'.repeat(64) }],
    budgets: [
      { kind: 'sol-spend-limit', address: null, raw: '123', units: 'lamports' },
    ],
    participants: [
      { role: 'developer', address: item.mint, mode: 'unavailable' },
    ],
    signature: null,
    signatureScope: 'single-transaction',
    receiptPresent: true,
    packetCount: 1,
    signingAllowed: false,
    executionAllowed: false,
    receiptVerified: false,
  };
  fetchMock.mockImplementation(async (url, init) => {
    expect(init?.method ?? 'GET').toBe('GET');
    if (url === '/api/account-launch-recoveries') return Response.json(page);
    if (typeof url === 'string' && url.includes('view=inspection'))
      return Response.json(inspection);
    throw Error('Unexpected lookup or workflow');
  });
  await mount();
  await click('Find saved launch recovery');
  const disclosure = [...host.querySelectorAll('details')].find(
    (d) =>
      d.querySelector('summary')?.textContent === 'Saved review inspection',
  )!;
  expect(disclosure).toBeTruthy();
  await act(async () => {
    disclosure.open = true;
    disclosure.dispatchEvent(new Event('toggle', { bubbles: true }));
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  await click('Inspect saved review');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('Original retained token');
  expect(host.textContent).toContain(
    'finalized (stored only; not fresh finality',
  );
  expect(host.textContent).toContain('Original recovery reference');
  expect(
    [...host.querySelectorAll('button')].some((b) =>
      b.textContent?.includes('Approve'),
    ),
  ).toBe(false);
  expect(host.querySelector('input[type="password"]')).toBeNull();
});
