// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  RecoveryProjectNavigationProvider,
  RecoveryProjectOpenButton,
} from './recovery-project-navigation';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import {
  EMPTY_IDENTITY,
  DEFAULT_VENUE_OPTIONS,
  type WorkspaceProject,
} from '@/lib/workspace-project';

function project(id = 'saved-one', archived = false): WorkspaceProject {
  return {
    id,
    archived,
    updatedAt: '2026-10-24T12:00:00.000Z',
    plan: {
      ...structuredClone(DEFAULT_LAUNCH_PLAN),
      tokenName: 'Current saved launch',
    },
    identity: structuredClone(EMPTY_IDENTITY),
    options: structuredClone(DEFAULT_VENUE_OPTIONS),
  };
}
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn<typeof fetch>();
const onOpen = vi.fn<(project: WorkspaceProject) => void>();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetcher);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  fetcher.mockReset();
  onOpen.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function render({
  ids = ['saved-one'],
  blocked = false,
  callback = onOpen,
  provider = true,
  strict = false,
}: {
  ids?: string[];
  blocked?: boolean;
  callback?: (project: WorkspaceProject) => void;
  provider?: boolean;
  strict?: boolean;
} = {}) {
  const children = ids.map((id) => (
    <div key={id} data-project-id={id}>
      <RecoveryProjectOpenButton projectId={id} />
    </div>
  ));
  const content = provider ? (
    <RecoveryProjectNavigationProvider onOpen={callback} blocked={blocked}>
      {children}
    </RecoveryProjectNavigationProvider>
  ) : (
    children
  );
  await act(async () =>
    root.render(strict ? <StrictMode>{content}</StrictMode> : content),
  );
}
function container(index = 0) {
  return host.querySelectorAll<HTMLDivElement>('[data-project-id]')[index];
}
function button(label = 'Open current saved project', index = 0) {
  return [
    ...container(index).querySelectorAll<HTMLButtonElement>('button'),
  ].find((b) => b.textContent === label)!;
}
async function click(label = 'Open current saved project', index = 0) {
  expect(button(label, index)).toBeTruthy();
  await act(async () => button(label, index).click());
}
function defer() {
  let resolve!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  return (response: Response) => act(async () => resolve(response));
}
function response(id = 'saved-one', archived = false) {
  return Response.json({ project: project(id, archived) });
}

it('renders no control without the guarded provider and never reads automatically', async () => {
  await render({ provider: false });
  expect(host.querySelector('button')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  await render({ strict: true });
  expect(button()).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
  await render({ strict: true, blocked: true });
  expect(button().disabled).toBe(true);
  await click();
  expect(fetcher).not.toHaveBeenCalled();
});
it('requests only the exact owned project GET and calls the guarded callback without claiming navigation or authority', async () => {
  fetcher.mockResolvedValueOnce(response());
  await render();
  await click();
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/projects/saved-one', {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
    signal: expect.any(AbortSignal),
  });
  expect(onOpen).toHaveBeenCalledOnce();
  expect(onOpen.mock.calls[0][0]).toMatchObject({
    id: 'saved-one',
    archived: false,
    plan: { tokenName: 'Current saved launch' },
  });
  expect(host.textContent).toContain('Project open requested');
  expect(host.textContent).toContain('unsaved-draft prompt');
  expect(host.textContent).toContain(
    'no review was selected or approval renewed',
  );
  expect(host.textContent).not.toContain('Project opened successfully');
});
it('uses the latest callback during an ordinary parent rerender without aborting or restarting the read', async () => {
  const finish = defer(),
    newer = vi.fn();
  await render();
  await click();
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await render({ callback: newer });
  expect(signal.aborted).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
  await finish(response());
  expect(onOpen).not.toHaveBeenCalled();
  expect(newer).toHaveBeenCalledOnce();
});

it('does not publish stale success when the guarded owner callback synchronously removes the provider', async () => {
  const callback = vi.fn(() => {
    flushSync(() => root.render(<p>Owner navigation decision is pending.</p>));
  });
  await render({ callback });
  fetcher.mockResolvedValueOnce(response());
  await click();
  expect(callback).toHaveBeenCalledOnce();
  expect(host.textContent).toBe('Owner navigation decision is pending.');
  expect(host.querySelector('output')).toBeNull();
  expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
});
it('refuses archived projects without restoration or silently substituting another project', async () => {
  fetcher.mockResolvedValueOnce(response('saved-one', true));
  await render();
  await click();
  expect(onOpen).not.toHaveBeenCalled();
  expect(host.textContent).toContain('archived');
  expect(host.textContent).toContain('not opened or restored');
  expect(host.textContent).toContain('Archived projects manually');
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each([401, 404, 403, 503])(
  'handles HTTP%s with fixed visible recovery guidance and no callback',
  async (status) => {
    const cancel = vi.fn();
    fetcher.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        status,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await render();
    await click();
    expect(cancel).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
    const link = host.querySelector('a');
    if (status === 401) {
      expect(link?.getAttribute('href')).toBe('/sign-in');
      expect(link?.target).toBe('_blank');
      expect(link?.rel).toBe('noopener noreferrer');
      expect(host.textContent).toContain('retry manually');
    } else {
      expect(link).toBeNull();
      expect(host.textContent).toContain('original recovery reference');
    }
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('clears sign-in on a manual retry and never resumes just because a user signs in elsewhere', async () => {
  fetcher.mockResolvedValueOnce(new Response('private html', { status: 401 }));
  await render();
  await click();
  await act(async () => vi.advanceTimersByTime(30000));
  expect(fetcher).toHaveBeenCalledOnce();
  const finish = defer();
  await click();
  expect(host.querySelector('a')).toBeNull();
  await finish(response());
  expect(onOpen).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  { project: { ...project(), id: 'different-owner-project' } },
  { project: { ...project(), archived: 0 } },
  { project: { ...project(), updatedAt: 'bad-date' } },
  { project: { ...project(), plan: null } },
  { project: project(), signingAllowed: true },
])(
  'refuses malformed, mismatched or extra-authority payloads without exposing raw text (%#)',
  async (payload) => {
    fetcher.mockResolvedValueOnce(Response.json(payload));
    await render();
    await click();
    expect(onOpen).not.toHaveBeenCalled();
    expect(host.textContent).toContain('unavailable');
    expect(host.querySelector('a')).toBeNull();
  },
);
it('refuses an invalid original ID before networking', async () => {
  await render({ ids: ['../outside?secret=1'] });
  await click();
  expect(fetcher).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
  expect(host.textContent).toContain('reference is unavailable');
});
it('releases a hung fetch at15seconds and ignores its later successful body after manual retry', async () => {
  const finish = defer();
  await render();
  await click();
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await act(async () => vi.advanceTimersByTime(15000));
  expect(signal.aborted).toBe(true);
  expect(button().disabled).toBe(false);
  expect(host.textContent).toContain('took too long');
  fetcher.mockResolvedValueOnce(response());
  await click();
  expect(onOpen).toHaveBeenCalledOnce();
  const cancel = vi.fn();
  await finish(new Response(new ReadableStream({ cancel })));
  expect(cancel).toHaveBeenCalledOnce();
  expect(onOpen).toHaveBeenCalledOnce();
});
it('cancels an unfinished body at15seconds without navigating', async () => {
  const cancel = vi.fn();
  fetcher.mockResolvedValueOnce(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await render();
  await click();
  await act(async () => vi.advanceTimersByTime(15000));
  expect(cancel).toHaveBeenCalledOnce();
  expect(onOpen).not.toHaveBeenCalled();
  expect(button().disabled).toBe(false);
  expect(host.textContent).toContain('took too long');
});
it.each([401, 200])(
  'manual cancellation discards late HTTP%s and never opens or shows stale auth',
  async (status) => {
    const finish = defer();
    await render();
    await click();
    const signal = fetcher.mock.calls[0][1]!.signal!;
    await click('Cancel project read');
    expect(signal.aborted).toBe(true);
    await finish(
      status === 200 ? response() : new Response('expired', { status }),
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toContain('read cancelled');
  },
);
it('cancels on project identity/page replacement and never carries old messages into the new button', async () => {
  const finish = defer();
  await render();
  await click();
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await render({ ids: ['saved-two'] });
  expect(signal.aborted).toBe(true);
  await finish(response());
  expect(onOpen).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('open requested');
  expect(fetcher).toHaveBeenCalledOnce();
  fetcher.mockResolvedValueOnce(response('saved-two'));
  await click();
  expect(onOpen.mock.calls[0][0].id).toBe('saved-two');
});
it('aborts active work when blocked and requires a new manual action after unblocking', async () => {
  const finish = defer();
  await render();
  await click();
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await render({ blocked: true });
  expect(signal.aborted).toBe(true);
  expect(button().disabled).toBe(true);
  await finish(response());
  expect(onOpen).not.toHaveBeenCalled();
  await render({ blocked: false });
  expect(button().disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
  fetcher.mockResolvedValueOnce(response());
  await click();
  expect(onOpen).toHaveBeenCalledOnce();
});
it('coordinates two project buttons so newest request aborts older work and only newest may navigate', async () => {
  const first = defer(),
    second = defer();
  await render({ ids: ['saved-one', 'saved-two'] });
  await click();
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await click('Open current saved project', 1);
  expect(signal.aborted).toBe(true);
  expect(container(0).textContent).toContain(
    'another saved project was requested',
  );
  await first(response());
  expect(onOpen).not.toHaveBeenCalled();
  await second(response('saved-two'));
  expect(onOpen).toHaveBeenCalledOnce();
  expect(onOpen.mock.calls[0][0].id).toBe('saved-two');
});
it('cancels when the discovery page removes a button while retaining the provider', async () => {
  const finish = defer();
  await render();
  await click();
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await render({ ids: [] });
  expect(signal.aborted).toBe(true);
  await finish(response());
  expect(onOpen).not.toHaveBeenCalled();
  await render();
  expect(button().disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
});
it('cancels provider unmount and sanitizes callback or fetch failures without retrying', async () => {
  const finish = defer();
  await render();
  await click();
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await render({ provider: false });
  expect(signal.aborted).toBe(true);
  await finish(response());
  expect(onOpen).not.toHaveBeenCalled();
  const failure = vi.fn(() => {
    throw Error('private raw callback error');
  });
  await render({ callback: failure });
  fetcher.mockResolvedValueOnce(response());
  await click();
  expect(host.textContent).not.toContain('private raw callback error');
  expect(host.textContent).toContain('unavailable');
  fetcher.mockRejectedValueOnce(Error('secret endpoint'));
  await click();
  expect(host.textContent).not.toContain('secret endpoint');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
