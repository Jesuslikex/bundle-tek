// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VolumeBotLauncher } from './volume-bot-launcher';

vi.mock('./volume-bot-panel', () => ({
  VolumeBotPanel: ({ project }: { project: { id: string } }) => (
    <div data-testid="panel">{project.id}</div>
  ),
}));

let host: HTMLDivElement;
let root: Root;

const project = (id: string, chain: string, archived = false) => ({
  id,
  revision: 1,
  archived,
  updatedAt: '2026-11-01T00:00:00.000Z',
  document: { token: { chain, address: `addr-${id}`, name: `Token ${id}` } },
});

function stubFetch(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })),
  );
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const render = () =>
  act(async () => {
    root.render(
      <VolumeBotLauncher wallets={[]} locked={false} onClose={vi.fn()} />,
    );
    await Promise.resolve();
  });

const text = () => document.body.textContent ?? '';
const buttons = () => [...document.body.querySelectorAll('button')];

it('lists only Solana, unarchived tokens', async () => {
  stubFetch({
    projects: [
      project('a', 'Solana'),
      project('b', 'Ethereum'),
      project('c', 'Solana', true),
    ],
  });
  await render();
  expect(text()).toContain('Token a');
  expect(text()).not.toContain('Token b');
  expect(text()).not.toContain('Token c');
});

it('filters by search', async () => {
  stubFetch({ projects: [project('a', 'Solana'), project('b', 'Solana')] });
  await render();
  const search = document.body.querySelector<HTMLInputElement>(
    '[aria-label="Search imported tokens"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(search, 'Token b');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(text()).toContain('Token b');
  expect(text()).not.toContain('Token a');
});

it('mounts the volume panel for the chosen token', async () => {
  stubFetch({ projects: [project('a', 'Solana')] });
  await render();
  await act(async () => {
    buttons()
      .find((b) => b.textContent?.includes('Token a'))!
      .click();
  });
  expect(
    document.body.querySelector('[data-testid="panel"]')?.textContent,
  ).toBe('a');
});

it('says so when there are no imported tokens', async () => {
  stubFetch({ projects: [] });
  await render();
  expect(text()).toContain('No imported Solana tokens yet');
});

it('reports a list failure', async () => {
  stubFetch({ error: 'Storage down.' }, false);
  await render();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
    'Storage down.',
  );
});
