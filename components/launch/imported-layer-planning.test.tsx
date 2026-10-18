// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { ImportedLayerPlanning } from './imported-layer-planning';
import { layerUiFixture } from '../../test/launch-layer-ui-fixture';
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
const f = layerUiFixture(),
  project = { id: f.selection.projectId, updatedAt: f.updatedAt };
const value = () => ({
  projectId: project.id,
  projectUpdatedAt: project.updatedAt,
  items: [
    {
      id: 'import-a',
      revision: 3,
      chain: 'Solana',
      mint: f.address(90),
      name: 'First token',
      symbol: 'ONE',
    },
    {
      id: 'import-b',
      revision: 4,
      chain: 'Solana',
      mint: f.address(91),
      name: 'Second token',
      symbol: 'TWO',
    },
  ],
  hasMore: false,
  readOnly: true,
  fundingAllowed: false,
  signingAllowed: false,
  executionAllowed: false,
});
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name)!;
async function render(scheduled = true, disabled = false, p = project) {
  await act(async () =>
    root.render(
      <ImportedLayerPlanning
        project={p}
        scheduled={scheduled}
        disabled={disabled}
      />,
    ),
  );
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function select(id: string) {
  await act(async () => {
    const e = host.querySelector('select')!;
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!.call(e, id);
    e.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  fetcher = vi.fn(async () => Response.json({ targets: value() }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('requires scheduling and an explicit choice, then opens the real exact imported planner', async () => {
  await render(false);
  expect(button('Load imported tokens').disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  await render();
  await click('Load imported tokens');
  expect(host.querySelector('select')?.value).toBe('');
  expect(button('Plan Front / Back layers')).toBeUndefined();
  await select('import-b');
  expect(host.textContent).toContain('Second token');
  await act(async () => {
    button('Plan Front / Back layers').click();
    await vi.dynamicImportSettled();
  });
  const panel = host.querySelector(
    '[aria-label="Front and Back layer planning"]',
  );
  expect(panel?.textContent).toContain(f.address(91));
  expect(panel?.textContent).toContain('import-b, revision 4');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await select('import-a');
  expect(
    host.querySelector('[aria-label="Front and Back layer planning"]'),
  ).toBeNull();
});
it('clears the old target and review on reload, failure and source revision changes', async () => {
  await render();
  await click('Load imported tokens');
  await select('import-a');
  fetcher.mockResolvedValueOnce(
    new Response('<html>bad gateway</html>', { status: 502 }),
  );
  await click('Reload imported tokens');
  expect(host.querySelector('select')).toBeNull();
  expect(host.querySelector('[role=alert]')?.textContent).not.toMatch(
    /html|Unexpected|JSON/,
  );
  expect(button('Plan Front / Back layers')).toBeUndefined();
  await render(true, false, {
    ...project,
    updatedAt: '2026-10-18T05:00:00.000Z',
  });
  expect(host.querySelector('[role=alert]')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('refuses a forged list rather than selecting its first record', async () => {
  fetcher.mockResolvedValueOnce(
    Response.json({ targets: { ...value(), signingAllowed: true } }),
  );
  await render();
  await click('Load imported tokens');
  expect(host.querySelector('[role=alert]')).not.toBeNull();
  expect(host.querySelector('select')).toBeNull();
});
it('shows empty and incomplete-list states honestly', async () => {
  fetcher.mockResolvedValueOnce(
    Response.json({ targets: { ...value(), items: [] } }),
  );
  await render();
  await click('Load imported tokens');
  expect(host.textContent).toContain('No active Solana imports');
  fetcher.mockResolvedValueOnce(
    Response.json({
      targets: {
        ...value(),
        hasMore: true,
        nextCursor: {
          version: 1,
          projectId: project.id,
          projectUpdatedAt: project.updatedAt,
          search: '',
          id: 'cap-99',
          revision: 3,
          updatedAt: project.updatedAt,
        },
        items: Array.from({ length: 100 }, (_, i) => ({
          ...value().items[0],
          id: 'cap-' + i,
        })),
      },
    }),
  );
  await click('Reload imported tokens');
  expect(host.textContent).toContain('Up to 100 per page');
  expect(host.querySelector('select')?.value).toBe('');
});
it('times out even if transport ignores abort and discards its late response', async () => {
  vi.useFakeTimers();
  let finish!: (r: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await click('Load imported tokens');
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(host.querySelector('[role=alert]')?.textContent).toContain(
    'timed out',
  );
  expect(button('Load imported tokens').disabled).toBe(false);
  await act(async () => finish(Response.json({ targets: value() })));
  expect(host.querySelector('select')).toBeNull();
});
it('cancels a pending read and releases the synchronous request guard', async () => {
  let finish!: (r: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await act(async () => {
    button('Load imported tokens').click();
    button('Load imported tokens').click();
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await click('Cancel token loading');
  expect(host.textContent).toContain('Loading cancelled');
  await click('Load imported tokens');
  expect(host.querySelector('select')).not.toBeNull();
  await act(async () =>
    finish(Response.json({ targets: { ...value(), items: [] } })),
  );
  expect(host.querySelectorAll('option')).toHaveLength(3);
});

it('aborts and ignores a pending list when the saved source revision changes', async () => {
  let finish!: (r: Response) => void;
  let signal: AbortSignal | undefined;
  fetcher.mockImplementationOnce((_url, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await render();
  await click('Load imported tokens');
  await render(true, false, {
    ...project,
    updatedAt: '2026-10-18T05:00:00.000Z',
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(Response.json({ targets: value() })));
  expect(host.querySelector('select')).toBeNull();
  expect(host.querySelector('[role=alert]')).toBeNull();
  expect(button('Load imported tokens').disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('explains expired sign-in without exposing a server error body', async () => {
  fetcher.mockResolvedValueOnce(
    Response.json({ error: 'private server diagnostic' }, { status: 401 }),
  );
  await render();
  await click('Load imported tokens');
  expect(host.querySelector('[role=alert]')?.textContent).toBe(
    'Sign in to choose an imported token.',
  );
  expect(host.textContent).not.toContain('private server diagnostic');
  expect(host.querySelector('select')).toBeNull();
});

async function searchText(value: string) {
  await act(async () => {
    const field = host.querySelector<HTMLInputElement>('input[type=search]')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('clears selected planning when searching and binds the search response to its exact query', async () => {
  await render();
  await click('Load imported tokens');
  await select('import-a');
  await searchText('  TWO  ');
  expect(host.querySelector('select')).toBeNull();
  expect(button('Plan Front / Back layers')).toBeUndefined();
  fetcher.mockImplementationOnce(async (url: string) => {
    const query = JSON.parse(
      new URL(url, 'https://bundle.test').searchParams.get('targets')!,
    );
    expect(query.search).toBe('TWO');
    expect(query.cursor).toBeUndefined();
    return Response.json({
      targets: { ...value(), search: 'TWO', items: [value().items[1]] },
    });
  });
  await click('Search imported tokens');
  expect(host.textContent).toContain('matching “TWO”');
  expect(host.querySelector('select')?.value).toBe('');
});
it('pages forward and back without automatically selecting or retaining a previous planner', async () => {
  const cursor = {
    version: 1 as const,
    projectId: project.id,
    projectUpdatedAt: project.updatedAt,
    search: '',
    id: 'cap-99',
    revision: 3,
    updatedAt: project.updatedAt,
  };
  const first = {
    ...value(),
    items: Array.from({ length: 100 }, (_, i) => ({
      ...value().items[0],
      id: 'cap-' + i,
    })),
    hasMore: true,
    nextCursor: cursor,
  };
  fetcher.mockResolvedValueOnce(Response.json({ targets: first }));
  await render();
  await click('Load imported tokens');
  await select('cap-0');
  fetcher.mockImplementationOnce(async (url: string) => {
    expect(
      JSON.parse(
        new URL(url, 'https://bundle.test').searchParams.get('targets')!,
      ).cursor,
    ).toEqual(cursor);
    return Response.json({
      targets: { ...value(), pageCursor: cursor, items: [value().items[1]] },
    });
  });
  await click('Next imports');
  expect(host.textContent).toContain('Page 2');
  expect(host.querySelector('select')?.value).toBe('');
  expect(button('Plan Front / Back layers')).toBeUndefined();
  expect(button('Next imports').disabled).toBe(true);
  fetcher.mockResolvedValueOnce(Response.json({ targets: first }));
  await click('Previous imports');
  expect(host.textContent).toContain('Page 1');
  expect(button('Previous imports').disabled).toBe(true);
  expect(host.querySelector('select')?.value).toBe('');
});

it('submits search on Enter without submitting a parent form and focuses the returned choices', async () => {
  await render();
  await searchText('ONE');
  fetcher.mockResolvedValueOnce(
    Response.json({
      targets: { ...value(), search: 'ONE', items: [value().items[0]] },
    }),
  );
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    host.querySelector('input[type=search]')!.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(host.querySelector('select'));
  expect(host.querySelector('output')?.textContent).toContain('Page 1');
});
