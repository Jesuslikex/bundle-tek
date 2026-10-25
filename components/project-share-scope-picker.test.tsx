// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectShareScopePicker } from './project-share-scope-picker';
import type { ProjectShareWallet } from '@/lib/project-share-scope';

const revision = '2026-10-25T12:00:00.000Z';
const wallets: ProjectShareWallet[] = [
  {
    chain: 'Solana',
    address: '11111111111111111111111111111111',
    revision: 1,
    role: 'Deployer',
  },
  {
    chain: 'Solana',
    address: 'SysvarRent111111111111111111111111111111111',
    revision: 2,
    role: 'Recipient',
  },
];
const response = (overrides = {}) => ({
  shares: [],
  source: {
    projectId: 'project-a',
    projectRevision: revision,
    candidates: structuredClone(wallets),
    ...overrides,
  },
});
let root: Root, container: HTMLDivElement;
const onChange = vi.fn();
const fetcher = vi.fn();
let requests: {
  url: string;
  init: RequestInit;
  resolve: (value: Response) => void;
}[];

async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
async function render(projectId = 'project-a', busy = false) {
  await act(async () =>
    root.render(
      <ProjectShareScopePicker
        projectId={projectId}
        busy={busy}
        onChange={onChange}
      />,
    ),
  );
}
function loadButton() {
  return container.querySelector('button')!;
}
async function load() {
  await act(async () => loadButton().click());
}
async function resolve(index: number, value: unknown, status = 200) {
  await act(async () =>
    requests[index].resolve(Response.json(value, { status })),
  );
  await settle();
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onChange.mockReset();
  requests = [];
  fetcher
    .mockReset()
    .mockImplementation(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({ url, init, resolve }),
        ),
    );
  vi.stubGlobal('fetch', fetcher);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('does not read or change the parent on mount or when opening the disclosure', async () => {
  await render();
  expect(container.querySelector('details')!.open).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => container.querySelector('summary')!.click());
  expect(container.querySelector('details')!.open).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
  expect(container.textContent).toContain('no wallet assignments by default');
  expect(container.textContent).toContain('never added automatically');
});

it('loads only on demand, starts unchecked, and emits only explicitly selected public references', async () => {
  await render();
  await load();
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('/api/projects/shares?projectId=project-a');
  expect(requests[0].init.cache).toBe('no-store');
  expect(requests[0].init.method).toBeUndefined();
  await resolve(0, response());
  const checks = [...container.querySelectorAll<HTMLInputElement>('input')];
  expect(checks).toHaveLength(2);
  expect(checks.every((input) => !input.checked)).toBe(true);
  expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
    format: 'project-share-wallet-scope-v1',
    projectRevision: revision,
    wallets: [],
  });
  await act(async () => checks[1].click());
  expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
    format: 'project-share-wallet-scope-v1',
    projectRevision: revision,
    wallets: [wallets[1]],
  });
  expect(container.textContent).toContain(
    '1 saved assignment reference selected',
  );
  await act(async () => checks[1].click());
  expect(onChange.mock.calls.at(-1)?.[0].wallets).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('clears prior selection before a manual reload instead of silently adding refreshed wallets', async () => {
  await render();
  await load();
  await resolve(0, response());
  await act(async () => container.querySelector('input')!.click());
  await load();
  expect(onChange.mock.calls.at(-1)?.[0]).toBeNull();
  expect(container.querySelector('input')).toBeNull();
  await resolve(1, response({ projectRevision: '2026-10-25T13:00:00.000Z' }));
  expect(onChange.mock.calls.at(-1)?.[0].wallets).toEqual([]);
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input')].every(
      (e) => !e.checked,
    ),
  ).toBe(true);
});

it.each([
  { projectId: 'foreign-project' },
  { projectRevision: 'invalid' },
  { candidates: [{ ...wallets[0], folderId: 'private-folder' }] },
  { candidates: [wallets[0], wallets[0]] },
  { candidates: [{ ...wallets[0], address: 'invalid' }] },
  { candidates: [{ ...wallets[0], role: 'Admin' }] },
])(
  'refuses a malformed or cross-project assignment source %s',
  async (overrides) => {
    await render();
    await load();
    await resolve(0, response(overrides));
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(onChange.mock.calls).toEqual([[null]]);
  },
);

it('explains unavailable project source without inventing an empty saved revision', async () => {
  await render();
  await load();
  await resolve(0, { shares: [], source: null });
  expect(container.textContent).toContain(
    'Saved project assignments are unavailable.',
  );
  expect(onChange.mock.calls).toEqual([[null]]);
});

it('explains sign-in expiry and never retries automatically', async () => {
  await render();
  await load();
  await resolve(0, { error: 'Private server details' }, 401);
  expect(container.textContent).toContain(
    'Sign in to choose saved wallet assignments.',
  );
  expect(container.textContent).not.toContain('Private server details');
  await settle();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls).toEqual([[null]]);
});

it('turns an HTML error page into readable guidance without raw parser text', async () => {
  await render();
  await load();
  await act(async () =>
    requests[0].resolve(
      new Response('<html>private</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  await settle();
  expect(container.textContent).toContain('Wallet assignments unavailable.');
  expect(container.textContent).not.toContain('private');
  expect(container.textContent).not.toContain('Unexpected token');
  expect(container.querySelector('input')).toBeNull();
});

it('disables loading and selection during a parent task', async () => {
  await render('project-a', true);
  expect(loadButton().disabled).toBe(true);
  await load();
  expect(fetcher).not.toHaveBeenCalled();
  await render();
  await load();
  await resolve(0, response());
  await render('project-a', true);
  const fieldset = container.querySelector('fieldset')!;
  expect(fieldset.disabled).toBe(true);
  await act(async () => container.querySelector('input')!.click());
  expect(onChange.mock.calls.at(-1)?.[0].wallets).toEqual([]);
});

it('aborts a pending read and discards its reply on project change', async () => {
  await render();
  await load();
  const signal = requests[0].init.signal as AbortSignal;
  await render('project-b');
  expect(signal.aborted).toBe(true);
  await resolve(0, response());
  expect(container.querySelector('input')).toBeNull();
  expect(container.textContent).not.toContain(wallets[0].address);
  expect(onChange.mock.calls).toEqual([[null]]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('resets selected candidates on project change without a new read', async () => {
  await render();
  await load();
  await resolve(0, response());
  await act(async () => container.querySelector('input')!.click());
  const before = onChange.mock.calls.length;
  await render('project-b');
  expect(container.querySelector('input')).toBeNull();
  expect(container.querySelector('details')!.open).toBe(false);
  expect(onChange).toHaveBeenCalledTimes(before);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
