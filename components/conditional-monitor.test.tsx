// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ConditionalMonitor } from './conditional-monitor';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type {
  ConditionalMonitorPage,
  MonitorNotice,
} from '@/lib/conditional-monitor';
import bs58 from 'bs58';
const projectId = '11111111-1111-4111-8111-111111111111',
  orderId = '22222222-2222-4222-8222-222222222222';
let root: Root, container: HTMLDivElement, project: ImportedTokenProject;
const review =
  vi.fn<(orderId: string, revision: number, level: number) => void>();
let requests: {
  url: string;
  init: RequestInit;
  resolve: (r: Response) => void;
}[];
const empty = (): ConditionalMonitorPage => ({
  projectId,
  executionAllowed: false,
  workerLastSeenAt: null,
  monitor: null,
  notices: [],
});
const monitor = (enabled = true) => ({
  revision: 1,
  projectRevision: 1,
  enabled,
  nextCheckAt: Date.now(),
  lastCheckedAt: null,
  error: null,
});
function notice(revision = 1): MonitorNotice {
  const time = Date.now() - 60000;
  return {
    id: '33333333-3333-4333-8333-333333333333',
    projectId,
    projectRevision: revision,
    monitorRevision: 1,
    observedAt: new Date(time).toISOString(),
    expiresAt: new Date(time + 30000).toISOString(),
    source: 'api.dexscreener.com',
    checkedOrders: 1,
    unavailableOrders: 0,
    executionAllowed: false,
    matches: [
      {
        orderId,
        revision: 1,
        side: 'Buy',
        pair: bs58.encode(new Uint8Array(32).fill(6)),
        direction: 'at-or-below',
        observedMarketCapUsd: '80',
        levels: [{ level: 2, targetUsd: '100', unitsRaw: '11' }],
      },
    ],
  };
}
const button = (name: string) => {
  const b = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(name),
  );
  if (!b) throw new Error('Missing button ' + name);
  return b;
};
const click = async (name: string) =>
  act(async () => {
    button(name).click();
  });
const respond = async (n: number, value: unknown, status = 200) =>
  act(async () => {
    requests[n].resolve(Response.json(value, { status }));
  });
const openNotice = async () =>
  act(async () => {
    const d = container.querySelector('details')!;
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
  });
beforeEach(async () => {
  requests = [];
  review.mockReset();
  project = {
    id: projectId,
    revision: 1,
    archived: false,
  } as ImportedTokenProject;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({ url, init, resolve }),
        ),
    ),
  );
  await act(async () => {
    root.render(<ConditionalMonitor project={project} onReview={review} />);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(document, 'hidden');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('loads on demand and saves an explicit monitoring request without claiming an inactive worker is running', async () => {
  expect(requests).toHaveLength(0);
  await click('Reload background');
  await respond(0, empty());
  await click('Request background');
  expect(JSON.parse(requests[1].init.body as string)).toEqual({
    projectId,
    projectRevision: 1,
    monitorRevision: 0,
    enabled: true,
  });
  await respond(1, { ...empty(), monitor: monitor() });
  expect(container.textContent).toContain('Monitoring requested');
  expect(container.textContent).toContain('No recent worker heartbeat');
  expect(review).not.toHaveBeenCalled();
});
it('exposes sampled notices and routes review only through the supplied explicit callback', async () => {
  await click('Reload background');
  await respond(0, {
    ...empty(),
    monitor: monitor(),
    workerLastSeenAt: Date.now(),
    notices: [notice()],
  });
  expect(container.textContent).toContain('An older notice does not prove');
  await openNotice();
  expect(container.textContent).toContain('sample freshness ended');
  expect(review).not.toHaveBeenCalled();
  await click('Review matched level 2');
  expect(review).toHaveBeenCalledExactlyOnceWith(orderId, 1, 2);
  expect(requests).toHaveLength(1);
});
it('disables review for historical revisions and the parent busy state', async () => {
  await click('Reload background');
  await respond(0, { ...empty(), notices: [notice(2)] });
  await openNotice();
  expect(button('Review matched').disabled).toBe(true);
  await act(async () =>
    root.render(
      <ConditionalMonitor project={project} onReview={review} reviewDisabled />,
    ),
  );
  expect(button('Review matched').disabled).toBe(true);
  expect(review).not.toHaveBeenCalled();
});
it('allows pausing an archived project while preventing new requests and review', async () => {
  await act(async () =>
    root.render(
      <ConditionalMonitor
        project={{ ...project, archived: true }}
        onReview={review}
      />,
    ),
  );
  await click('Reload background');
  await respond(0, { ...empty(), monitor: monitor(), notices: [notice()] });
  await openNotice();
  expect(button('Pause background').disabled).toBe(false);
  expect(button('Review matched').disabled).toBe(true);
  await click('Pause background');
  expect(JSON.parse(requests[1].init.body as string).enabled).toBe(false);
});
it('rejects foreign project and extra execution payloads before rendering or callback', async () => {
  await click('Reload background');
  await respond(0, {
    ...empty(),
    projectId: '99999999-9999-4999-8999-999999999999',
  });
  expect(container.querySelector('[role=alert]')).not.toBeNull();
  expect(review).not.toHaveBeenCalled();
  await click('Reload background');
  await respond(1, {
    ...empty(),
    notices: [{ ...notice(), transaction: 'unexpected-private-packet' }],
  });
  expect(container.textContent).not.toContain('unexpected-private-packet');
  expect(container.querySelector('[role=alert]')).not.toBeNull();
});
it('mounts notice details on demand and paginates all matching orders', async () => {
  const n = notice();
  const groups = Array.from({ length: 6 }, () => ({
    ...n.matches[0],
    orderId: crypto.randomUUID(),
  }));
  await click('Reload background');
  await respond(0, {
    ...empty(),
    notices: [{ ...n, checkedOrders: 6, matches: groups }],
  });
  expect(
    Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('Review matched'),
    ),
  ).toHaveLength(0);
  await openNotice();
  expect(
    Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('Review matched'),
    ),
  ).toHaveLength(5);
  await click('More notice orders');
  expect(container.textContent).toContain('Showing orders 6 to 6 of 6.');
  await click('Review matched level 2');
  expect(review).toHaveBeenCalledExactlyOnceWith(groups[5].orderId, 1, 2);
});
it('aborts in-flight reads on unmount and keeps failures readable for non-JSON gateways', async () => {
  await click('Reload background');
  await act(async () => {
    requests[0].resolve(
      new Response('<html>bad gateway</html>', { status: 502 }),
    );
  });
  expect(container.textContent).toContain('Monitoring unavailable.');
  expect(container.textContent).not.toContain('Unexpected token');
  await click('Reload background');
  expect(requests[1].init.signal?.aborted).toBe(false);
  await act(async () => root.unmount());
  expect(requests[1].init.signal?.aborted).toBe(true);
  root = createRoot(container);
});
it('follows new retained matches, retries a gateway failure and never writes or reviews automatically', async () => {
  vi.useFakeTimers();
  await click('Follow monitoring notices');
  await respond(0, { ...empty(), monitor: monitor(), notices: [notice()] });
  expect(container.textContent).toContain('Latest 1 retained match notices');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  await act(async () =>
    requests[1].resolve(new Response('<html>gateway</html>', { status: 502 })),
  );
  expect(container.textContent).toContain('retrying');
  expect(container.textContent).toContain('Latest 1 retained match notices');
  expect(container.textContent).not.toContain('<html>');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  const newer = { ...notice(), id: '44444444-4444-4444-8444-444444444444' };
  await respond(2, { ...empty(), notices: [newer, notice()] });
  expect(container.textContent).toContain('Latest 2 retained match notices');
  expect(container.textContent).toContain('2 successful reads');
  expect(requests.every((r) => !r.init.method || r.init.method === 'GET')).toBe(
    true,
  );
  expect(review).not.toHaveBeenCalled();
  await click('Stop following monitoring notices');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(requests).toHaveLength(3);
});
it('aborts hidden-tab reads and resumes when visible without accepting a stale response', async () => {
  vi.useFakeTimers();
  await click('Follow monitoring notices');
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: true,
  });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(requests[0].init.signal?.aborted).toBe(true);
  expect(container.textContent).toContain('Tab hidden');
  await respond(0, { ...empty(), notices: [notice()] });
  expect(container.textContent).not.toContain('Latest 1 retained');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(requests).toHaveLength(1);
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: false,
  });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(requests).toHaveLength(2);
  await respond(1, { ...empty(), notices: [notice()] });
  expect(container.textContent).toContain('Latest 1 retained');
});
it('clears project state, stops following, and rejects both manual and followed stale responses on revision changes', async () => {
  await click('Reload background');
  await respond(0, { ...empty(), notices: [notice()] });
  await click('Follow monitoring notices');
  expect(requests).toHaveLength(2);
  await act(async () =>
    root.render(
      <ConditionalMonitor
        project={{ ...project, revision: 2 }}
        onReview={review}
      />,
    ),
  );
  expect(requests[1].init.signal?.aborted).toBe(true);
  await respond(1, { ...empty(), notices: [notice()] });
  expect(container.textContent).not.toContain('Latest 1 retained');
  expect(button('Follow monitoring notices')).toBeDefined();
  await click('Reload background');
  await act(async () =>
    root.render(
      <ConditionalMonitor
        project={{ ...project, revision: 3 }}
        onReview={review}
      />,
    ),
  );
  expect(requests[2].init.signal?.aborted).toBe(true);
  await respond(2, { ...empty(), notices: [notice()] });
  expect(container.textContent).not.toContain('Latest 1 retained');
  expect(review).not.toHaveBeenCalled();
});
it('pauses following during a manual settings update and rejects the earlier followed snapshot', async () => {
  await click('Reload background');
  await respond(0, empty());
  await click('Follow monitoring notices');
  await click('Request background');
  expect(requests[1].init.signal?.aborted).toBe(true);
  expect(requests[2].init.method).toBe('POST');
  await respond(2, { ...empty(), monitor: monitor() });
  expect(container.textContent).toContain('Monitoring requested');
  expect(requests).toHaveLength(4);
  await respond(1, {
    ...empty(),
    monitor: monitor(false),
    notices: [notice()],
  });
  expect(container.textContent).toContain('Monitoring requested');
  expect(container.textContent).not.toContain('Latest 1 retained');
  await respond(3, { ...empty(), monitor: monitor(), notices: [notice()] });
  expect(container.textContent).toContain('Latest 1 retained');
  expect(review).not.toHaveBeenCalled();
});
