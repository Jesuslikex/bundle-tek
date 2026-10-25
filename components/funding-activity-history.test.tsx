// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FundingActivityHistory } from './funding-activity-history';

let container: HTMLDivElement, root: Root;
let requests: {
  url: string;
  init?: RequestInit;
  resolve: (r: Response) => void;
}[];
const plan = (id = 'funding', revision = 2, chain = 'Solana') => ({
  id,
  revision,
  archived: true,
  document: {
    name: 'Latest draft',
    chain,
    total: '1',
    currency: 'SOL',
    recipients: [],
  },
});
async function render(id = 'funding', refreshRevision = 0) {
  await act(async () =>
    root.render(
      <FundingActivityHistory
        id={id}
        eventName="Historical draft"
        refreshRevision={refreshRevision}
        onClose={() => {}}
      />,
    ),
  );
}
async function respond(index: number, value: unknown, status = 200) {
  await act(async () =>
    requests[index].resolve(Response.json(value, { status })),
  );
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  );
  if (!button) throw new Error('Missing button: ' + label);
  await act(async () => button.click());
}
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
  vi.unstubAllGlobals();
});

it('separates saved mainnet and devnet history, loading mainnet only on explicit open', async () => {
  await render();
  await respond(0, { plan: plan() });
  expect(container.textContent).toContain('Archived');
  expect(container.textContent).toContain('Devnet test history');
  expect(requests.map((r) => r.url)).toEqual([
    '/api/funding?id=funding',
    '/api/funding/history?id=funding&revision=2',
  ]);
  await respond(1, {
    id: 'funding',
    revision: 2,
    archived: true,
    receipts: [],
    pending: [],
    pendingTruncated: false,
    nextCursor: null,
  });
  await click('Open mainnet');
  expect(requests[2].url).toBe('/api/funding/mainnet-history?id=funding');
  await respond(2, {
    id: 'funding',
    name: 'Latest draft',
    currentRevision: 2,
    archived: true,
    revision: null,
    executionAllowed: false,
    events: [],
    progress: { revision: 2, records: [] },
    nextCursor: null,
  });
  expect(container.textContent).not.toContain('unavailable. Reload history');
  expect(container.textContent).toContain(
    'No retained mainnet funding transitions in this filter.',
  );
  expect(container.textContent).toContain(
    'Only verified receipts establish delivery',
  );
  expect(
    requests.every((r) => !r.init?.method || r.init.method === 'GET'),
  ).toBe(true);
});

it('does not mount Solana history for a different chain', async () => {
  await render();
  await respond(0, { plan: plan('funding', 2, 'Base') });
  expect(requests).toHaveLength(1);
  expect(container.textContent).toContain(
    'Execution receipt history for Base is not available',
  );
});

it.each([401, 403, 404, 429, 502])(
  'uses readable status errors for HTML %s without exposing the body',
  async (status) => {
    await render();
    await act(async () =>
      requests[0].resolve(
        new Response('<html>private parser details</html>', {
          status,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    expect(container.querySelector('[role=alert]')).not.toBeNull();
    expect(container.textContent).not.toMatch(
      /private parser|Unexpected token|<html>/,
    );
    if (status === 401)
      expect(container.textContent).toContain('Sign in again');
    await click('Retry funding history');
    expect(requests).toHaveLength(2);
  },
);

it.each(['<html>private</html>', '{bad json'])(
  'hides malformed success bodies and offers retry: %s',
  async (body) => {
    await render();
    await act(async () =>
      requests[0].resolve(
        new Response(body, { headers: { 'content-type': 'application/json' } }),
      ),
    );
    expect(container.querySelector('[role=alert]')?.textContent).toBe(
      'Funding draft unavailable. Retry funding history to try again.',
    );
  },
);

it('refuses mismatched drafts and ignores an aborted old identity', async () => {
  await render();
  await render('other');
  expect(requests[0].init?.signal?.aborted).toBe(true);
  await respond(0, { plan: plan() });
  expect(container.textContent).not.toContain('Latest draft');
  await respond(1, { plan: plan() });
  expect(container.textContent).toContain('Funding draft response mismatch');
});

it.each(['chain', 'currency', 'document'])(
  'refuses malformed %s before rendering a history panel',
  async (field) => {
    await render();
    const value: Record<string, unknown> = plan();
    if (field === 'document') value.document = null;
    else
      (value.document as Record<string, unknown>)[field] = { malformed: true };
    await respond(0, { plan: value });
    expect(container.textContent).toContain('Funding draft response mismatch');
    expect(requests).toHaveLength(1);
  },
);

it('reload clears the open mainnet panel and aborts prior history reads', async () => {
  await render();
  await respond(0, { plan: plan() });
  await click('Open mainnet');
  await click('Reload funding draft');
  expect(requests[1].init?.signal?.aborted).toBe(true);
  expect(requests[2].init?.signal?.aborted).toBe(true);
  await respond(3, { plan: plan('funding', 3) });
  expect(container.textContent).toContain('revision 3');
  expect(container.textContent).toContain('Open mainnet funding history');
  expect(requests[4].url).toContain('revision=3');
});
