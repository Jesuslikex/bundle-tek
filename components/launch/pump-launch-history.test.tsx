// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { PumpLaunchHistory } from './pump-launch-history';
let root: Root, container: HTMLDivElement;
const row = (id: string, state = 'signed', projectId = 'project') => ({
  review: { id, projectId },
  state,
  signature: null,
  receipt: null,
});
let fetcher: ReturnType<typeof vi.fn>;
const click = async (text: string) => {
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find(
        (b) => b.textContent === text || b.getAttribute('aria-label') === text,
      )!
      .click(),
  );
};
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.body) {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return Response.json({
        ...row(body.id, 'cancelled'),
        receipt: { kind: 'expired-unobserved' },
      });
    }
    return Response.json({
      nextCursor: null,
      launches: path.includes('holders')
        ? [row('older'), row('newest', 'review')]
        : [row(path.includes('initial-buy') ? 'developer' : 'create')],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await act(async () => {
    root.render(<PumpLaunchHistory projectId="project" />);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
it('appends older records with the selected type cursor and preserves the first page on failure', async () => {
  fetcher.mockImplementation(async (path: string) =>
    path.includes('cursor=')
      ? Response.json({ launches: [row('older-page')], nextCursor: null })
      : Response.json({
          launches: [row('first-page')],
          nextCursor: path.includes('holders') ? 'cursor1' : null,
        }),
  );
  await click('Reload all saved launches');
  await click('Load older holder buys launches');
  expect(fetcher.mock.calls.at(-1)![0]).toBe(
    '/api/launch/pump/holders?projectId=project&page=1&cursor=cursor1',
  );
  expect(container.textContent).toContain('Review: first-page');
  expect(container.textContent).toContain('Review: older-page');
  expect(container.textContent).not.toContain('Load older holder buys');
  fetcher.mockImplementation(async (path: string) =>
    path.includes('cursor=')
      ? new Response('<html>bad</html>', { status: 503 })
      : Response.json({
          launches: [row('first-page')],
          nextCursor: path.includes('holders') ? 'cursor1' : null,
        }),
  );
  await click('Reload all saved launches');
  await click('Load older holder buys launches');
  expect(container.textContent).toContain('Review: first-page');
  expect(container.textContent).toContain('Load older holder buys');
});
it('refuses overlapping pages and cursor loops without replacing existing rows', async () => {
  fetcher.mockImplementation(async (path: string) =>
    Response.json({
      launches: [row('same')],
      nextCursor: path.includes('holders') ? 'cursor1' : null,
    }),
  );
  await click('Reload all saved launches');
  await click('Load older holder buys launches');
  expect(container.textContent).toContain('Status check did not complete');
  expect(container.querySelectorAll('li')).toHaveLength(3);
  fetcher.mockImplementation(async () =>
    Response.json({ launches: [row('same')], nextCursor: 'cursor2' }),
  );
  await click('Load older holder buys launches');
  expect(container.querySelectorAll('li')).toHaveLength(3);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('loads all launch types automatically without signing or submitting', async () => {
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.every(([, init]) => !init?.body)).toBe(true);
  for (const id of ['older', 'newest', 'developer', 'create'])
    expect(container.textContent).toContain('Review: ' + id);
  expect(container.querySelectorAll('input')).toHaveLength(0);
  expect(container.textContent).not.toContain('Approve and sign');
});
it('recovers the selected older packet on its own route, without signing or submitting', async () => {
  await click('Reload all saved launches');
  await click('Check holder buys status: older');
  const [path, init] = fetcher.mock.calls.at(-1)!;
  expect(path).toBe('/api/launch/pump/holders');
  expect(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')).toEqual(
    {
      action: 'recover',
      id: 'older',
    },
  );
  expect(container.textContent).toContain('Holder buys: Cancelled');
  expect(container.textContent).toContain('Network fees remain unresolved');
  expect(container.textContent).toContain('Review: newest');
});
it('keeps working history when a provider returns an HTML error page', async () => {
  fetcher.mockImplementation(async (path: string) =>
    path.includes('holders')
      ? new Response('<html>private raw parser detail</html>', { status: 503 })
      : Response.json({ launches: [row('available')], nextCursor: null }),
  );
  await click('Reload all saved launches');
  expect(container.textContent).toContain('Holder buys history is unavailable');
  expect(container.textContent).toContain('Review: available');
  expect(container.textContent).not.toContain('private raw parser detail');
});
it('rejects records from another project and mismatched recovery responses', async () => {
  fetcher.mockImplementation(async () =>
    Response.json({
      launches: [row('foreign', 'signed', 'other')],
      nextCursor: null,
    }),
  );
  await click('Reload all saved launches');
  expect(container.textContent).not.toContain('Review: foreign');
  fetcher.mockImplementation(async (_path: string, init?: RequestInit) =>
    init?.body
      ? Response.json(row('wrong-id', 'finalized'))
      : Response.json({ launches: [row('original')], nextCursor: null }),
  );
  await click('Reload all saved launches');
  await click('Check holder buys status: original');
  expect(container.textContent).toContain('Status check did not complete');
  expect(container.textContent).not.toContain('wrong-id');
});
it('aborts and clears the previous project history when the project changes', async () => {
  await click('Reload all saved launches');
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  fetcher.mockImplementation(async (_path: string, init?: RequestInit) => {
    signal = init?.signal as AbortSignal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return Response.json(row('older', 'finalized'));
  });
  act(() =>
    [...container.querySelectorAll('button')]
      .find(
        (b) =>
          b.getAttribute('aria-label') === 'Check holder buys status: older',
      )!
      .click(),
  );
  act(() => root.render(<PumpLaunchHistory projectId="changed" />));
  expect(signal?.aborted).toBe(true);
  await act(async () => finish());
  expect(container.textContent).not.toContain('Review: older');
  expect(container.textContent).not.toContain('finalized');
});

it('sorts mixed launch types by saved date and exposes shortened explorer signatures and copy', async () => {
  const signature = '2'.repeat(88);
  fetcher.mockImplementation(async (path: string) =>
    Response.json({
      nextCursor: null,
      launches: [
        {
          ...row(
            path.includes('holders')
              ? 'middle'
              : path.includes('initial-buy')
                ? 'latest'
                : 'earliest',
          ),
          signature,
          createdAt: path.includes('holders')
            ? '2026-10-14T12:00:00Z'
            : path.includes('initial-buy')
              ? '2026-10-15T12:00:00Z'
              : '2026-10-13T12:00:00Z',
        },
      ],
    }),
  );
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  await click('Reload all saved launches');
  const items = [...container.querySelectorAll('li')];
  expect(items.map((item) => item.querySelector('time')?.dateTime)).toEqual([
    '2026-10-15T12:00:00Z',
    '2026-10-14T12:00:00Z',
    '2026-10-13T12:00:00Z',
  ]);
  expect(items[0].querySelector('a')?.href).toBe(
    'https://solscan.io/tx/' + signature,
  );
  expect(items[0].querySelector('a')?.textContent).toBe('22222222…22222222');
  await click('Copy signature: latest');
  expect(writeText).toHaveBeenCalledWith(signature);
  expect(container.textContent).toContain('Signature copied.');
});
it('opens the selected unsigned saved review through the owning screen callback without a transaction request', async () => {
  const onOpenReview = vi.fn();
  await act(async () =>
    root.render(
      <PumpLaunchHistory projectId="project" onOpenReview={onOpenReview} />,
    ),
  );
  const before = fetcher.mock.calls.length;
  await click('Open holder buys review: newest');
  expect(onOpenReview).toHaveBeenCalledWith({
    source: '/api/launch/pump/holders',
    value: row('newest', 'review'),
  });
  expect(fetcher).toHaveBeenCalledTimes(before);
});
