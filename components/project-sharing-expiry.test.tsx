// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectSharePanel, SharedProjectsPanel } from './project-sharing';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { EMPTY_IDENTITY, DEFAULT_VENUE_OPTIONS } from '@/lib/workspace-project';
let container: HTMLDivElement, root: Root;
let requests: {
  url: string;
  init?: RequestInit;
  resolve: (r: Response) => void;
}[];
const id = '11111111-1111-4111-8111-111111111111';
const share = (expiresAt: string | null = '2026-10-26T00:00:00.000Z') => ({
  id,
  accepted: false,
  createdAt: '2026-10-25T00:00:00.000Z',
  acceptedAt: null,
  expiresAt,
  expired: false,
});
const project = (expiresAt: string | null) => ({
  id: 'shared-project',
  shareId: id,
  readOnly: true,
  archived: false,
  updatedAt: '2026-10-25T00:00:00.000Z',
  plan: DEFAULT_LAUNCH_PLAN,
  identity: EMPTY_IDENTITY,
  options: DEFAULT_VENUE_OPTIONS,
  expiresAt,
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({ url, init, resolve }),
        ),
    ),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function respond(index: number, value: unknown, status = 200) {
  await act(async () =>
    requests[index].resolve(Response.json(value, { status })),
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!button) throw Error('Missing ' + text);
  await act(async () => button.click());
}
it('defaults to24h, sends selected duration and displays exact returned expiry', async () => {
  await act(async () =>
    root.render(<ProjectSharePanel projectId="shared-project" />),
  );
  await respond(0, { shares: [] });
  const select = container.querySelector('select')!;
  expect(select.value).toBe('86400');
  await act(async () => {
    select.value = '604800';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Create invite link');
  expect(JSON.parse(requests[1].init!.body as string)).toEqual({
    action: 'invite',
    projectId: 'shared-project',
    expiresInSeconds: 604800,
  });
  const expiresAt = '2026-11-01T00:00:00.000Z';
  await respond(1, { share: { id, token: 'A'.repeat(43), expiresAt } });
  await respond(2, { shares: [share(expiresAt)] });
  expect(container.querySelector('code')?.textContent).toContain(
    '?share=' + 'A'.repeat(43),
  );
  expect(container.querySelector('time')?.dateTime).toBe(expiresAt);
  expect(container.textContent).toContain(
    'Already viewed or copied plans cannot be recalled',
  );
});
it('discards the initial list when an invite refresh wins the race', async () => {
  await act(async () =>
    root.render(<ProjectSharePanel projectId="shared-project" />),
  );
  await click('Create invite link');
  expect(requests[0].init?.signal?.aborted).toBe(true);
  await respond(1, {
    share: { id, token: 'A'.repeat(43), expiresAt: share().expiresAt },
  });
  await respond(2, { shares: [share()] });
  await respond(0, { shares: [] });
  expect(container.textContent).toContain('Unused invite');
});
it('keeps expired and legacy rows inspectable and revocable without silently renewing', async () => {
  await act(async () =>
    root.render(<ProjectSharePanel projectId="shared-project" />),
  );
  await respond(0, {
    shares: [
      { ...share('2026-01-01T00:00:00.000Z'), expired: true },
      { ...share(null), id: '22222222-2222-4222-8222-222222222222' },
    ],
  });
  expect(container.textContent).toContain('Expired');
  expect(container.textContent).toContain('No expiry (legacy share)');
  await click('Revoke');
  expect(JSON.parse(requests[1].init!.body as string)).toEqual({
    action: 'revoke',
    id,
  });
  await respond(1, { ok: true });
  await respond(2, { shares: [] });
  expect(container.textContent).not.toContain('Unused invite');
});
it('allows GET-only refresh after an interrupted invite response', async () => {
  await act(async () =>
    root.render(<ProjectSharePanel projectId="shared-project" />),
  );
  await respond(0, { shares: [] });
  await click('Create invite link');
  await respond(1, { share: { token: 'A'.repeat(43) } });
  expect(container.textContent).toContain(
    'Refresh shares before creating another invite',
  );
  await click('Refresh shares');
  expect(requests[2].init?.method).toBeUndefined();
  await respond(2, { shares: [share()] });
  expect(container.querySelector('code')).toBeNull();
});
it('hides an expired cached member snapshot without writing, auto-refreshing or restoring authority', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T16:00:00.000Z'));
  await act(async () => root.render(<SharedProjectsPanel />));
  await respond(0, { projects: [project('2026-10-25T16:00:01.000Z')] });
  expect(container.textContent).toContain('Access ends');
  await act(async () => vi.advanceTimersByTime(1001));
  expect(container.textContent).not.toContain('Access ends');
  expect(requests).toHaveLength(1);
});
it('labels a legacy member share without an automatic expiry', async () => {
  await act(async () => root.render(<SharedProjectsPanel />));
  await respond(0, { projects: [project(null)] });
  expect(container.textContent).toContain('No expiry (legacy share)');
  expect(requests.every((r) => !r.init?.method)).toBe(true);
});

it('shows a specific expired-share conflict without accepting or renewing anything', async () => {
  window.history.replaceState(null, '', '/?share=' + 'A'.repeat(43));
  try {
    await act(async () => root.render(<SharedProjectsPanel />));
    await respond(0, { projects: [] });
    await click('Accept invite');
    await respond(
      1,
      {
        error:
          'Ask the owner to revoke your expired share before accepting a new invite.',
      },
      409,
    );
    expect(container.textContent).toContain(
      'Ask the owner to revoke your expired share',
    );
    expect(requests).toHaveLength(2);
  } finally {
    window.history.replaceState(null, '', '/');
  }
});
