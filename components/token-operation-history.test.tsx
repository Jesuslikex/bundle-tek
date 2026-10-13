// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { TokenOperationHistory } from './token-operation-history';
import bs58 from 'bs58';
import { importedTokenDocument } from '@/lib/imported-token-project';
import { tradeSessionTerms } from '@/lib/imported-trade-session';
import type { SessionEntryOutcomes } from '@/lib/session-entry-outcomes';
import {
  historyCursor,
  type OperationPage,
  type TokenOperation,
  type OperationCategory,
} from '@/lib/token-operation-history';
const project = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
let container: HTMLDivElement, root: Root;
let requests: {
  url: string;
  signal: AbortSignal | null | undefined;
  resolve: (response: Response) => void;
}[];
function record(n: number, projectId = project): TokenOperation {
  return {
    key: 'project:' + n.toString(16).padStart(32, '0'),
    projectId,
    source: 'project',
    category: 'Project',
    createdAt: '2026-10-13T00:00:00.000Z',
    label: `Saved event ${n}`,
    state: 'recorded',
    details: [`Retained details ${n}`],
    signature: null,
  };
}
function page(
  records: TokenOperation[],
  category: OperationCategory = 'All',
  projectId = project,
  nextCursor: string | null = null,
): OperationPage {
  return {
    projectId,
    category,
    executionAllowed: false,
    records,
    nextCursor,
    missingSources: [],
  };
}
const button = (name: string) => {
  const b = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(name),
  );
  if (!b) throw new Error('Button missing: ' + name);
  return b;
};
async function click(name: string) {
  await act(async () => {
    button(name).click();
  });
}
async function respond(index: number, body: unknown, status = 200) {
  await act(async () => {
    requests[index].resolve(Response.json(body, { status }));
  });
}
beforeEach(async () => {
  requests = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({ url, signal: init?.signal, resolve }),
        ),
    ),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<TokenOperationHistory projectId={project} revision={1} />);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('loads only on open, discloses source gaps, expands details and appends older pages without duplicates', async () => {
  expect(fetch).not.toHaveBeenCalled();
  await click('Open token');
  expect(requests).toHaveLength(1);
  expect(button('Reload').disabled).toBe(true);
  const first = page(
    [record(3), record(2)],
    'All',
    project,
    historyCursor(project, 'All', record(2).key),
  );
  first.missingSources = ['job'];
  await respond(0, first);
  expect(container.textContent).toContain('incomplete source coverage');
  expect(container.querySelectorAll('li')).toHaveLength(2);
  await act(async () => {
    container.querySelector('summary')!.click();
  });
  expect(container.querySelector('details')!.open).toBe(true);
  await click('Load older');
  expect(
    new URL(requests[1].url, 'http://test').searchParams.get('cursor'),
  ).toBe(first.nextCursor);
  await respond(1, page([record(2), record(1)]));
  expect(container.querySelectorAll('li')).toHaveLength(3);
  expect(container.textContent).toContain('Retained details 1');
  expect(
    Array.from(container.querySelectorAll('button')).some((b) =>
      b.textContent?.includes('Load older'),
    ),
  ).toBe(false);
});
it('aborts an obsolete filter request and withholds its late response', async () => {
  await click('Open token');
  const select = container.querySelector('select')!;
  await act(async () => {
    select.value = 'Withdrawals';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(requests[0].signal?.aborted).toBe(true);
  expect(
    new URL(requests[1].url, 'http://test').searchParams.get('category'),
  ).toBe('Withdrawals');
  await respond(0, page([record(99)]));
  expect(container.textContent).not.toContain('Saved event 99');
  const withdrawal = {
    ...record(1),
    key: 'withdrawal:' + '1'.padStart(32, '0'),
    source: 'withdrawal' as const,
    category: 'Withdrawals' as const,
    label: 'Withdrawal review retained',
    state: 'awaiting_signature',
  };
  await respond(1, page([withdrawal], 'Withdrawals'));
  expect(container.textContent).toContain('Withdrawal review retained');
  expect(container.querySelectorAll('li')).toHaveLength(1);
});
it('switches projects and closes history without retaining obsolete responses', async () => {
  await click('Open token');
  await act(async () => {
    root.render(<TokenOperationHistory projectId={other} revision={1} />);
  });
  expect(requests[0].signal?.aborted).toBe(true);
  expect(
    new URL(requests[1].url, 'http://test').searchParams.get('projectId'),
  ).toBe(other);
  await respond(0, page([record(99)]));
  expect(container.textContent).not.toContain('Saved event 99');
  await click('Close token');
  expect(requests[1].signal?.aborted).toBe(true);
  await respond(1, page([record(8, other)], 'All', other));
  expect(container.querySelector('ol')).toBeNull();
  await click('Open token');
  expect(requests).toHaveLength(3);
  await respond(2, page([record(7, other)], 'All', other));
  expect(container.textContent).toContain('Saved event 7');
  expect(container.textContent).not.toContain('Saved event 8');
});
it('rejects mismatched responses and reloads through a fresh request', async () => {
  await click('Open token');
  await respond(0, page([record(1, other)], 'All', other));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'unavailable',
  );
  expect(container.querySelectorAll('li')).toHaveLength(0);
  await click('Reload');
  await respond(1, page([record(1)]));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelectorAll('li')).toHaveLength(1);
  await click('Reload');
  await respond(2, { error: 'History storage temporarily unavailable.' }, 503);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'temporarily unavailable',
  );
  expect(container.querySelectorAll('li')).toHaveLength(1);
});
it('selects warmup history, expands retained context and avoids a mainnet link when network evidence is unavailable', async () => {
  await click('Open token');
  await respond(0, page([]));
  const select = container.querySelector('select')!;
  expect([...select.options].some((option) => option.value === 'Warmup')).toBe(
    true,
  );
  await act(async () => {
    select.value = 'Warmup';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(
    new URL(requests[1].url, 'http://test').searchParams.get('category'),
  ).toBe('Warmup');
  const warmup: TokenOperation = {
    ...record(1),
    key: 'warmup:' + '1'.padStart(32, '0'),
    source: 'warmup',
    category: 'Warmup',
    label: 'Warmup Sell: Submission attempt reserved; check finalized outcome',
    state: 'submitted',
    details: [
      'Plan revision 4, cycle 2',
      'Network evidence is unavailable; no mainnet receipt is asserted.',
    ],
  };
  await respond(1, page([warmup], 'Warmup'));
  await act(async () => container.querySelector('summary')!.click());
  expect(container.querySelector('details')!.open).toBe(true);
  expect(container.textContent).toContain('Plan revision 4, cycle 2');
  expect(container.textContent).toContain('Network evidence is unavailable');
  expect(container.querySelector('a')).toBeNull();
  await click('Reload');
  expect(
    new URL(requests[2].url, 'http://test').searchParams.get('category'),
  ).toBe('Warmup');
  await respond(2, page([warmup], 'Warmup'));
  expect(container.querySelectorAll('li')).toHaveLength(1);
});
it('opens a current all-wallet session breakdown through the owned immutable event without changing the earlier history state', async () => {
  const stamp = '2026-10-13T00:00:00.000Z';
  const mint = bs58.encode(new Uint8Array(32).fill(3));
  const savedProject = {
    id: project,
    revision: 1,
    archived: false,
    updatedAt: stamp,
    document: importedTokenDocument(
      { chain: 'Solana', address: mint },
      {
        chain: 'Solana',
        address: mint,
        name: 'Fixture token',
        symbol: 'FIX',
        decimals: 6,
        totalSupplyRaw: '1000000000',
        metadataUri: '',
        observedAt: stamp,
        source: 'https://fixture.test',
      },
    ),
  };
  await act(async () =>
    root.render(
      <TokenOperationHistory
        projectId={project}
        revision={1}
        project={savedProject}
      />,
    ),
  );
  await click('Open token');
  const sourceId = 'd'.repeat(32);
  const historical: TokenOperation = {
    ...record(1),
    key: `session:${sourceId}`,
    source: 'session',
    category: 'Session',
    state: 'active',
    label: 'Original session saved',
    sessionEventId: sourceId,
    details: ['Earlier session event remains active in this captured record.'],
  };
  await respond(0, page([historical]));
  expect(requests).toHaveLength(1);
  await act(async () => container.querySelector('summary')!.click());
  await click('Open current session outcomes');
  expect(requests).toHaveLength(2);
  const query = new URL(requests[1].url, 'http://test').searchParams;
  expect(query.get('projectId')).toBe(project);
  expect(query.get('eventId')).toBe(sourceId);
  expect(query.has('sessionId')).toBe(false);
  const terms = tradeSessionTerms(
    {
      projectId: project,
      projectRevision: 1,
      side: 'Buy',
      entries: [2, 4].map((n) => ({
        wallet: bs58.encode(new Uint8Array(32).fill(n)),
        walletRevision: 1,
        amount: '0.001',
      })),
    },
    { chain: 'Solana', address: mint, decimals: 6 },
  );
  const snapshot: SessionEntryOutcomes = {
    projectId: project,
    sourceEventId: sourceId,
    executionAllowed: false,
    session: {
      id: '00000000-0000-4000-8000-000000000040',
      revision: 2,
      state: 'cancelled',
      terms,
      createdAt: stamp,
      updatedAt: '2026-10-13T00:00:01.000Z',
    },
    sampledAt: '2026-10-13T00:00:02.000Z',
    missingSources: [],
    entries: terms.entries.map((entry) => ({
      ...entry,
      preparation: null,
      approval: null,
      receipt: null,
      receiptEvidence: 'not-applicable',
    })),
  };
  await respond(1, snapshot);
  expect(container.querySelector('summary')!.textContent).toContain(
    'Original session saved · active',
  );
  expect(container.textContent).toContain(
    'Earlier session event remains active',
  );
  expect(container.textContent).toContain('Entry 1');
  expect(container.textContent).toContain('Entry 2');
  expect(container.textContent).not.toContain('Skipped execution');
  await click('Close token');
  expect(container.querySelector('ol')).toBeNull();
});
it('rejects a session-event reference that does not match the history record identity', async () => {
  await click('Open token');
  const mismatched: TokenOperation = {
    ...record(1),
    source: 'session',
    category: 'Session',
    key: 'session:' + 'a'.repeat(32),
    sessionEventId: 'b'.repeat(32),
  };
  await respond(0, page([mismatched]));
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'Operation record differs',
  );
  expect(container.querySelector('li')).toBeNull();
});
