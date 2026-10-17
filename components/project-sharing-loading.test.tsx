// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectSharePanel, SharedProjectsPanel } from './project-sharing';

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  'shows a service message for an empty sharing failure (owner=%s)',
  async (owner) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const fetcher = vi.fn(async () => new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetcher);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          owner ? (
            <ProjectSharePanel projectId="p1" />
          ) : (
            <SharedProjectsPanel />
          ),
        ),
      );
      expect(container.querySelector('[role=alert]')?.textContent).toBe(
        owner
          ? 'Shares unavailable. Try again later.'
          : 'Shared projects unavailable. Try again later.',
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]).toEqual(
        owner
          ? ['/api/projects/shares?projectId=p1', { cache: 'no-store' }]
          : ['/api/projects/shares', { cache: 'no-store' }],
      );
    } finally {
      await act(async () => root.unmount());
    }
  },
);
