// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ProjectSharePanel, SharedProjectsPanel } from './project-sharing';
let container: HTMLDivElement, root: Root;
let calls: {
  url: string;
  init?: RequestInit;
  resolve: (r: Response) => void;
}[];
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => calls.push({ url, init, resolve })),
    ),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
async function respond(n: number, body: unknown) {
  await act(async () => calls[n].resolve(Response.json(body)));
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
const approvalBox = () =>
  [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('Approval link'))!
    .querySelector<HTMLInputElement>('input')!;
const body = (n: number) => JSON.parse(calls[n].init!.body as string);

it('creates an approval link only when ticked and the server echoes it', async () => {
  await act(async () =>
    root.render(<ProjectSharePanel projectId="project-a" />),
  );
  await respond(0, { shares: [] });
  expect(approvalBox().checked).toBe(false);
  await click('Create invite link');
  expect(body(1).approval).toBeUndefined();
  await respond(1, {
    share: {
      id,
      token: 'A'.repeat(43),
      expiresAt: '2026-12-01T00:00:00.000Z',
      permissions: { editMetadata: false },
      approval: false,
    },
  });
  await respond(2, { shares: [] });
  expect(container.textContent).toContain('Send this link to one collaborator');
  await act(async () => approvalBox().click());
  await click('Create approval link');
  expect(body(3).approval).toBe(true);
  // A server that ignores the request must not be shown as an approval link.
  await respond(3, {
    share: {
      id,
      token: 'B'.repeat(43),
      expiresAt: '2026-12-01T00:00:00.000Z',
      permissions: { editMetadata: false },
    },
  });
  expect(container.querySelector('code')).toBeNull();
  await click('Create approval link');
  await respond(4, {
    share: {
      id,
      token: 'B'.repeat(43),
      expiresAt: '2026-12-01T00:00:00.000Z',
      permissions: { editMetadata: false },
      approval: true,
    },
  });
  await respond(5, { shares: [] });
  expect(container.textContent).toContain('Send this approval link');
});

it('shows a waiting request with Approve and Decline, and sends the exact action', async () => {
  await act(async () =>
    root.render(<ProjectSharePanel projectId="project-a" />),
  );
  const share = {
    id,
    accepted: false,
    createdAt: '2026-11-11T10:00:00.000Z',
    acceptedAt: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
    expired: false,
    walletScope: { mode: 'none', count: 0 },
    permissions: { editMetadata: false },
    approval: true,
    requestedAt: '2026-11-11T10:05:00.000Z',
  };
  await respond(0, { shares: [share] });
  expect(container.textContent).toContain('waiting for your approval');
  await click('Approve');
  expect(body(1)).toEqual({ action: 'approve', id });
  await respond(1, { ok: true });
  await respond(2, {
    shares: [
      {
        ...share,
        accepted: true,
        acceptedAt: '2026-11-11T10:06:00.000Z',
        requestedAt: null,
      },
    ],
  });
  expect(container.textContent).toContain('Collaborator joined');
  expect(container.textContent).not.toContain('Approve');
});

it('offers no Approve for an unrequested approval link and Decline revokes a request', async () => {
  await act(async () =>
    root.render(<ProjectSharePanel projectId="project-a" />),
  );
  const base = {
    accepted: false,
    createdAt: '2026-11-11T10:00:00.000Z',
    acceptedAt: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
    expired: false,
    walletScope: { mode: 'none', count: 0 },
    permissions: { editMetadata: false },
    approval: true,
  };
  await respond(0, { shares: [{ ...base, id, requestedAt: null }] });
  expect(container.textContent).toContain('Unused approval link');
  expect(
    [...container.querySelectorAll('button')].some(
      (b) => b.textContent?.trim() === 'Approve',
    ),
  ).toBe(false);
  await click('Refresh shares');
  await respond(1, {
    shares: [{ ...base, id, requestedAt: '2026-11-11T10:05:00.000Z' }],
  });
  await click('Decline');
  expect(body(2)).toEqual({ action: 'revoke', id });
});

it('refuses a request time on a row that is not a waiting approval link', async () => {
  await act(async () =>
    root.render(<ProjectSharePanel projectId="project-a" />),
  );
  await respond(0, {
    shares: [
      {
        id,
        accepted: false,
        createdAt: '2026-11-11T10:00:00.000Z',
        acceptedAt: null,
        expiresAt: '2099-01-01T00:00:00.000Z',
        expired: false,
        approval: false,
        requestedAt: '2026-11-11T10:05:00.000Z',
      },
    ],
  });
  expect(container.textContent).toContain('Shares unavailable');
});

it('tells the requester that access was requested and shows no project', async () => {
  window.history.replaceState(null, '', '/?share=' + 'C'.repeat(43));
  await act(async () => root.render(<SharedProjectsPanel />));
  await respond(0, { projects: [] });
  await click('Accept invite');
  expect(body(1)).toEqual({ action: 'accept', token: 'C'.repeat(43) });
  await respond(1, { shareId: id, pending: true });
  await respond(2, { projects: [] });
  expect(container.textContent).toContain('Access requested');
  expect(container.querySelectorAll('li')).toHaveLength(0);
  expect(window.location.search).toBe('');
});
