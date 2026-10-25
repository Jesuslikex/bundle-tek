// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ProjectSharePanel, SharedProjectsPanel } from './project-sharing';
import { createScopedSharedProjectSnapshot } from '@/lib/shared-project-review';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { EMPTY_IDENTITY, DEFAULT_VENUE_OPTIONS } from '@/lib/workspace-project';
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
const checkbox = () =>
  container.querySelector<HTMLInputElement>('input[type=checkbox]')!;
it('starts unchecked and resets permission on A to B to A navigation', async () => {
  await act(async () =>
    root.render(<ProjectSharePanel projectId="project-a" />),
  );
  await respond(0, { shares: [] });
  expect(checkbox().checked).toBe(false);
  await act(async () => checkbox().click());
  expect(checkbox().checked).toBe(true);
  await act(async () =>
    root.render(<ProjectSharePanel projectId="project-b" />),
  );
  await respond(1, { shares: [] });
  expect(checkbox().checked).toBe(false);
  await act(async () =>
    root.render(<ProjectSharePanel projectId="project-a" />),
  );
  await respond(2, { shares: [] });
  expect(checkbox().checked).toBe(false);
  expect(calls.every((c) => !c.init?.method)).toBe(true);
});
it.each([undefined, false, true])(
  'requires an exact true permission echo before displaying an editing invite (%s)',
  async (echo) => {
    await act(async () =>
      root.render(<ProjectSharePanel projectId="project-a" />),
    );
    await respond(0, { shares: [] });
    await act(async () => checkbox().click());
    await click('Create invite link');
    expect(JSON.parse(calls[1].init!.body as string).permissions).toEqual({
      editMetadata: true,
    });
    await respond(1, {
      share: {
        id,
        token: 'A'.repeat(43),
        expiresAt: '2026-12-01T00:00:00.000Z',
        ...(echo === undefined ? {} : { permissions: { editMetadata: echo } }),
      },
    });
    if (echo === true) {
      await respond(2, { shares: [] });
      expect(container.querySelector('code')?.textContent).toContain('?share=');
    } else {
      expect(container.querySelector('code')).toBeNull();
      expect(container.textContent).toMatch(/refresh|revoke/i);
    }
  },
);
it.each([undefined, false, true])(
  'mounts the explicit-load editor only for a true admitted permission (%s)',
  async (editMetadata) => {
    await act(async () => root.render(<SharedProjectsPanel />));
    const document = {
      plan: DEFAULT_LAUNCH_PLAN,
      identity: EMPTY_IDENTITY,
      options: DEFAULT_VENUE_OPTIONS,
    };
    const snapshot = createScopedSharedProjectSnapshot(
      {
        id: 'shared-project',
        shareId: id,
        updatedAt: '2026-10-25T00:00:00.000Z',
        archived: false,
      },
      document,
      null,
      editMetadata === undefined ? undefined : { editMetadata },
    );
    await respond(0, { projects: [snapshot] });
    expect(container.textContent?.includes('Load current saved text')).toBe(
      editMetadata === true,
    );
    expect(calls).toHaveLength(1);
    expect(container.textContent).toMatch(
      editMetadata === true ? /saved-text editor permission/ : /view only/,
    );
  },
);
it('keeps pending receipt recovery visible after shared rows disappear without new reads', async () => {
  const reminder = {
    mutationId: '22222222-2222-4222-8222-222222222222',
    shareId: id,
    projectId: 'shared-project',
    reviewHash: 'a'.repeat(64),
  };
  localStorage.setItem(
    `bundle-shared-metadata-edit:${id}:shared-project`,
    JSON.stringify(reminder),
  );
  try {
    await act(async () => root.render(<SharedProjectsPanel />));
    await respond(0, { projects: [] });
    expect(container.textContent).toContain('Past shared-project edits');
    expect(container.textContent).toContain('shared-project');
    expect(calls).toHaveLength(1);
    expect(container.textContent).not.toContain('Load current saved text');
  } finally {
    localStorage.clear();
  }
});
