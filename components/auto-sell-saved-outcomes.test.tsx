// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoSellSavedOutcomes } from './auto-sell-saved-outcomes';
import {
  autoSellOutcomePage,
  autoSellOutcomeReference as ref,
} from '../test/auto-sell-outcome-fixture';
let host: HTMLDivElement, root: Root | null;
const fetcher =
  vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async () => Response.json(autoSellOutcomePage()));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <AutoSellSavedOutcomes projectId={ref.projectId} mint={ref.mint} />,
    ),
  );
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function fill(value: string) {
  await act(async () => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const loaded = () =>
  vi.waitFor(() =>
    expect(
      host.querySelector('[aria-label="Saved Sell approval page"]'),
    ).not.toBeNull(),
  );
const error = () =>
  vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
it('makes no request on mount/disclosure, and only an explicit GET displays saved status without packet or authority', async () => {
  expect(host.querySelector('label')!.control).toBe(
    host.querySelector('input'),
  );
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => host.querySelector('summary')!.click());
  expect(fetcher).not.toHaveBeenCalled();
  await click('Read latest saved approvals');
  await loaded();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe(
    `/api/imported-projects/signing?projectId=${ref.projectId}`,
  );
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
  });
  expect(host.textContent).toContain('Sell approvals from any source');
  expect(host.textContent).toContain(
    'Submission recorded; receipt proof not loaded',
  );
  expect(host.textContent).toContain('not a session total');
  expect(
    host.querySelector('output[aria-live="polite"]')!.textContent,
  ).toContain('Loaded 1 approval record');
  expect(document.activeElement).toBe(host.querySelector('h3'));
  expect(host.textContent).not.toContain('SYNTHETIC-UNSIGNED');
  expect(host.querySelectorAll('button')).toHaveLength(1);
});
it('rediscovers saved history after a complete remount, without local storage or automatic reload', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  await click('Read latest saved approvals');
  await loaded();
  await act(async () => root!.unmount());
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <AutoSellSavedOutcomes projectId={ref.projectId} mint={ref.mint} />,
    ),
  );
  expect(host.textContent).not.toContain(ref.intentId);
  expect(fetcher).toHaveBeenCalledOnce();
  await click('Read latest saved approvals');
  await loaded();
  expect(host.textContent).toContain(ref.intentId);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(storage).not.toHaveBeenCalled();
});
it('finds an exact approval ID and rejects a substituted response rather than adopting it', async () => {
  await fill(ref.intentId.toUpperCase());
  await click('Find approval');
  await loaded();
  expect(fetcher.mock.calls[0][0]).toContain(`intentId=${ref.intentId}`);
  await fill(ref.preparationId);
  await click('Find approval');
  await error();
  expect(
    host.querySelector('[aria-label="Saved Sell approval page"]'),
  ).toBeNull();
});
it('offers older reads on a zero-match page and does not mistake a filtered page for the whole history', async () => {
  const page = autoSellOutcomePage(),
    original = page.intents[0];
  page.intents = Array.from({ length: 50 }, (_, n) => {
    const row = structuredClone(original);
    row.id = `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`;
    row.document.id = row.id;
    row.side = 'Buy';
    return row;
  });
  page.nextCursor = page.intents.at(-1)!.id;
  fetcher.mockResolvedValueOnce(Response.json(page));
  await click('Read latest saved approvals');
  await loaded();
  expect(host.textContent).toContain('0 matching Sell approvals');
  expect(host.textContent).toContain('Older records remain');
  await click('Read older approvals');
  await vi.waitFor(() => expect(host.textContent).toContain(ref.intentId));
  expect(fetcher.mock.calls[1][0]).toContain(`cursor=${page.nextCursor}`);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each(['html', 'foreign-project', 'foreign-mint'] as const)(
  'controls %s failure without exposing raw diagnostics or replacing an earlier valid page',
  async (kind) => {
    await click('Read latest saved approvals');
    await loaded();
    const page = autoSellOutcomePage();
    if (kind === 'foreign-project') page.projectId = ref.preparationId;
    if (kind === 'foreign-mint')
      page.intents[0].document.inputMint = ref.wallet;
    fetcher.mockResolvedValueOnce(
      kind === 'html'
        ? new Response('<html>PRIVATE DIAGNOSTIC</html>', { status: 502 })
        : Response.json(page),
    );
    await click('Read latest saved approvals');
    await error();
    expect(host.textContent).toContain(ref.intentId);
    expect(host.textContent).toContain('previous page is unchanged');
    expect(host.textContent).not.toContain('PRIVATE DIAGNOSTIC');
  },
);
it('does not request malformed lookup IDs', async () => {
  await fill('../anything');
  await click('Find approval');
  await error();
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Enter a complete approval ID');
});
it.each([401, 403, 404])(
  'clears previous records on explicit access refusal %s rather than retaining another session’s data',
  async (status) => {
    await click('Read latest saved approvals');
    await loaded();
    fetcher.mockResolvedValueOnce(
      new Response('<html>PRIVATE access diagnostic</html>', { status }),
    );
    await click('Read latest saved approvals');
    await error();
    expect(
      host.querySelector('[aria-label="Saved Sell approval page"]'),
    ).toBeNull();
    expect(host.textContent).not.toContain(ref.intentId);
    expect(host.textContent).toContain(
      'Previously loaded records were cleared',
    );
    expect(host.textContent).not.toContain('PRIVATE access diagnostic');
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
it('cancels a held request and refuses its late result even after a newer successful read', async () => {
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click('Read latest saved approvals');
  const signal = fetcher.mock.calls[0][1]!.signal!;
  expect(document.activeElement?.textContent).toBe('Cancel history read');
  await click('Cancel history read');
  expect(signal.aborted).toBe(true);
  expect(document.activeElement?.textContent).toBe(
    'Read latest saved approvals',
  );
  await click('Read latest saved approvals');
  await loaded();
  const page = autoSellOutcomePage();
  page.intents[0].state = 'finalized';
  await act(async () => finish(Response.json(page)));
  expect(host.textContent).toContain(
    'Submission recorded; receipt proof not loaded',
  );
  expect(host.textContent).not.toContain('Finalized status recorded');
});
it('keeps the page/cursor on an older-read failure and returns focus when the last older-page button disappears', async () => {
  const first = autoSellOutcomePage(),
    original = first.intents[0];
  first.intents = Array.from({ length: 50 }, (_, n) => {
    const row = structuredClone(original);
    row.id = `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`;
    row.document.id = row.id;
    return row;
  });
  first.nextCursor = first.intents.at(-1)!.id;
  fetcher.mockResolvedValueOnce(Response.json(first));
  await click('Read latest saved approvals');
  await loaded();
  fetcher.mockResolvedValueOnce(
    new Response('<html>private upstream diagnostic</html>', { status: 503 }),
  );
  await click('Read older approvals');
  await error();
  expect(host.textContent).toContain(first.intents[0].id);
  expect(host.textContent).toContain('Older records remain');
  expect(document.activeElement?.textContent).toBe(
    'Read latest saved approvals',
  );
  await click('Read older approvals');
  await vi.waitFor(() => expect(host.textContent).toContain(ref.intentId));
  expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[2][0]);
  expect(
    [...host.querySelectorAll('button')].some(
      (b) => b.textContent === 'Read older approvals',
    ),
  ).toBe(false);
  expect(document.activeElement).toBe(host.querySelector('h3'));
});
it('trims surrounding spaces from a complete pasted ID without making it incomplete', async () => {
  await fill(`  ${ref.intentId}  `);
  await click('Find approval');
  await loaded();
  expect(fetcher.mock.calls[0][0]).toContain(`intentId=${ref.intentId}`);
});
it('does not steal focus back after the user moved outside the read controls', async () => {
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const outside = document.createElement('input');
  document.body.appendChild(outside);
  try {
    await click('Read latest saved approvals');
    outside.focus();
    await act(async () => finish(Response.json(autoSellOutcomePage())));
    await loaded();
    expect(document.activeElement).toBe(outside);
  } finally {
    outside.remove();
  }
});
it.each(['project', 'mint', 'unmount'] as const)(
  'invalidates a held read on %s without starting another request',
  async (kind) => {
    let finish!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await click('Read latest saved approvals');
    const signal = fetcher.mock.calls[0][1]!.signal!;
    if (kind === 'unmount') {
      await act(async () => root!.unmount());
      root = null;
    } else
      await act(async () =>
        root!.render(
          <AutoSellSavedOutcomes
            projectId={kind === 'project' ? ref.preparationId : ref.projectId}
            mint={kind === 'mint' ? ref.wallet : ref.mint}
          />,
        ),
      );
    expect(signal.aborted).toBe(true);
    await act(async () => finish(Response.json(autoSellOutcomePage())));
    expect(host.textContent).not.toContain(ref.intentId);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('reports timeout rather than leaving the read permanently busy', async () => {
  const timeout = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  fetcher.mockImplementationOnce(
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init!.signal!.addEventListener(
          'abort',
          () => reject(Error('PRIVATE abort text')),
          { once: true },
        ),
      ),
  );
  await click('Read latest saved approvals');
  await act(async () => timeout.abort());
  await error();
  expect(host.textContent).not.toContain('Reading saved approvals');
  expect(host.textContent).not.toContain('PRIVATE abort text');
});
