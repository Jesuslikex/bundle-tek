// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SharedProjectReview } from './shared-project-review';
import { SharedProjectsPanel } from './project-sharing';
import { decodeSharedProjectSnapshots } from '@/lib/shared-project-review';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { EMPTY_IDENTITY, DEFAULT_VENUE_OPTIONS } from '@/lib/workspace-project';
const saved = () => ({
  id: 'shared-plan-a',
  shareId: '11111111-1111-4111-8111-111111111111',
  readOnly: true,
  archived: false,
  updatedAt: '2026-10-24T08:00:00.000Z',
  plan: {
    ...structuredClone(DEFAULT_LAUNCH_PLAN),
    tokenName: 'Shared launch',
    description: 'Saved description',
  },
  identity: {
    ...EMPTY_IDENTITY,
    artworkUrl: 'https://example.invalid/art.png',
  },
  options: structuredClone(DEFAULT_VENUE_OPTIONS),
});
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  window.history.replaceState(null, '', '/');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function click(text: string) {
  const element = Array.from(host.querySelectorAll('button,summary')).find(
    (b) => b.textContent?.trim() === text,
  );
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
}
it('mounts the inspector in the existing shared panel with no fetch or mutation on expansion', async () => {
  const fetcher = vi.fn(async () => Response.json({ projects: [saved()] }));
  vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(<SharedProjectsPanel />));
  const details = host.querySelector('details')!;
  expect(details.open).toBe(false);
  await click('Inspect saved plan');
  expect(details.open).toBe(true);
  expect(host.textContent).toContain('Saved description');
  expect(host.textContent).toContain(
    'not observed balances, acquired supply, launch success or readiness',
  );
  expect(host.querySelectorAll('img,a,input,form')).toHaveLength(0);
  expect(host.textContent).not.toContain('Create invite link');
  expect(host.textContent).not.toContain('art.png');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual([
    '/api/projects/shares',
    { cache: 'no-store', signal: expect.any(AbortSignal) },
  ]);
});
it('shows supply percentages separately from a saved quote amount', async () => {
  const value = saved();
  let [project] = decodeSharedProjectSnapshots({ projects: [value] });
  await act(async () => root.render(<SharedProjectReview project={project} />));
  expect(host.textContent).toContain('20% of supply');
  value.plan.mode = 'Manual';
  const quoteValue = {
    ...value,
    plan: { ...value.plan, holdersBuyQuote: '1.25' },
  };
  [project] = decodeSharedProjectSnapshots({ projects: [quoteValue] });
  await act(async () => root.render(<SharedProjectReview project={project} />));
  const holder = Array.from(host.querySelectorAll('dt')).find(
    (e) => e.textContent === 'Holders buy (planned)',
  );
  expect(holder?.nextElementSibling?.textContent).toBe('1.25 SOL');
  [project] = decodeSharedProjectSnapshots({ projects: [value] });
  await act(async () => root.render(<SharedProjectReview project={project} />));
  expect(host.textContent).not.toContain('20 SOL');
  expect(host.textContent).toContain('Quote amount not saved');
});
it('collapses an expanded snapshot when saved terms change even at the same timestamp', async () => {
  const value = saved();
  let [project] = decodeSharedProjectSnapshots({ projects: [value] });
  await act(async () => root.render(<SharedProjectReview project={project} />));
  await click('Inspect saved plan');
  expect(host.querySelector('details')?.open).toBe(true);
  value.plan.description = 'New saved version';
  [project] = decodeSharedProjectSnapshots({ projects: [value] });
  await act(async () => root.render(<SharedProjectReview project={project} />));
  expect(host.querySelector('details')?.open).toBe(false);
  expect(host.textContent).toContain('New saved version');
});
it.each(['html', 'permission'])(
  'shows a readable error for %s instead of exposing an inspector',
  async (kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        kind === 'html'
          ? new Response('<h1>private parser detail</h1>', {
              headers: { 'content-type': 'text/html' },
            })
          : Response.json({ projects: [{ ...saved(), readOnly: false }] }),
      ),
    );
    await act(async () => root.render(<SharedProjectsPanel />));
    expect(host.querySelector('[role=alert]')?.textContent).toBe(
      'Shared projects unavailable. Try again later.',
    );
    expect(host.querySelector('details')).toBeNull();
    expect(host.textContent).not.toContain('private parser');
  },
);
it.each([401, 503])(
  'clears a previous snapshot when manual refresh returns %s',
  async (status) => {
    let reads = 0;
    const fetcher = vi.fn(async () =>
      ++reads === 1
        ? Response.json({ projects: [saved()] })
        : new Response(null, { status }),
    );
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(<SharedProjectsPanel />));
    await click('Inspect saved plan');
    await click('Refresh shared projects');
    expect(host.querySelector('details')).toBeNull();
    expect(host.textContent).not.toContain('Saved description');
    expect(fetcher).toHaveBeenCalledTimes(2);
    if (status === 401)
      expect(host.querySelector('[role=alert]')?.textContent).toBe(
        'Sign in to open shared projects.',
      );
    expect(fetcher.mock.calls).toEqual([
      [
        '/api/projects/shares',
        { cache: 'no-store', signal: expect.any(AbortSignal) },
      ],
      [
        '/api/projects/shares',
        { cache: 'no-store', signal: expect.any(AbortSignal) },
      ],
    ]);
  },
);

it('ignores an aborted older success after a newer signed-out response', async () => {
  let resolveOld!: (response: Response) => void;
  let reads = 0;
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    signals.push(init!.signal as AbortSignal);
    return ++reads === 1
      ? new Promise<Response>((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve(new Response(null, { status: 401 }));
  });
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(
      <StrictMode>
        <SharedProjectsPanel />
      </StrictMode>,
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(signals[0].aborted).toBe(true);
  await act(async () => resolveOld(Response.json({ projects: [saved()] })));
  expect(host.querySelector('details')).toBeNull();
  expect(host.querySelector('[role=alert]')?.textContent).toBe(
    'Sign in to open shared projects.',
  );
  expect(host.textContent).not.toContain('Shared launch');
});
it('retains a readable historical snapshot and warns about mismatched wallet assignments', async () => {
  const value = saved();
  value.plan.holderCount = 1;
  value.options.wallets = {
    chain: 'Solana',
    recipients: [
      {
        address: '11111111111111111111111111111111',
        revision: 1,
        folderRevision: 0,
        root: true,
      },
      {
        address: 'SysvarRent111111111111111111111111111111111',
        revision: 1,
        folderRevision: 0,
        root: true,
      },
    ],
  };
  const [project] = decodeSharedProjectSnapshots({ projects: [value] });
  await act(async () => root.render(<SharedProjectReview project={project} />));
  expect(host.textContent).toContain(
    'Saved wallet assignments do not match these plan settings',
  );
  expect(host.textContent).not.toContain('11111111111111111111111111111111');
});
it('keeps a supply allocation in percent even if a quote amount was also saved', async () => {
  const value = saved();
  const [project] = decodeSharedProjectSnapshots({
    projects: [{ ...value, plan: { ...value.plan, holdersBuyQuote: '1.25' } }],
  });
  await act(async () => root.render(<SharedProjectReview project={project} />));
  expect(host.textContent).toContain('20% of supply');
  expect(host.textContent).not.toContain('1.25 SOL');
});

it('gives shared rows unique accessible names and labels Pump fees separately from a generic saved option', async () => {
  const [project] = decodeSharedProjectSnapshots({ projects: [saved()] });
  await act(async () => root.render(<SharedProjectReview project={project} />));
  expect(host.querySelector('summary')?.getAttribute('aria-label')).toBe(
    'Inspect saved plan for Shared launch ($TOKEN)',
  );
  expect(host.textContent).toContain('Generic creator-tax option (saved)');
  expect(host.textContent).toContain('Pump creator-fee setting');
  expect(host.textContent).toContain('Pump default');
});
it('cancels the member read when the shared panel unmounts', async () => {
  let readSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      readSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    }),
  );
  await act(async () => root.render(<SharedProjectsPanel />));
  expect(readSignal?.aborted).toBe(false);
  await act(async () => root.render(<p>Closed</p>));
  expect(readSignal?.aborted).toBe(true);
});

it('shows a readable capability message without fetching when timed cancellation is unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  Object.defineProperty(AbortSignal, 'any', {
    ...descriptor,
    value: undefined,
  });
  try {
    await act(async () => root.render(<SharedProjectsPanel />));
    expect(host.querySelector('[role=alert]')?.textContent).toBe(
      'This browser cannot time-limit project reads. Update your browser to continue.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(AbortSignal, 'any', descriptor);
  }
});
