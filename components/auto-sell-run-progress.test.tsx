// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  it,
  expect,
  vi,
} from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import {
  initializeAutoSellRunStorageFixture,
  setupAutoSellRunStorageFixture,
  autoSellRunAttemptFixture,
} from '@/test/auto-sell-run-storage-fixture';
import {
  createOwnedAutoSellRun,
  reserveOwnedAutoSellAttempt,
  startOwnedAutoSellPreparation,
} from '@/lib/auto-sell-run-storage';
const identity = vi.hoisted(() => ({
  owner: 'progress-ui-owner',
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: identity.owner }),
}));
vi.mock('@/db', () => ({ getD1: () => identity.db }));
import { GET } from '@/app/api/imported-projects/auto-sell-run-progress/route';
import { AutoSellRunProgressPanel } from './auto-sell-run-progress';
let client: Client,
  body: Record<string, unknown>,
  props: Parameters<typeof AutoSellRunProgressPanel>[0],
  initial: typeof props;
let host: HTMLDivElement,
  root: Root,
  requests: {
    url: string;
    init?: RequestInit;
    resolve: (r: Response) => void;
  }[];
const observed = vi.fn();
beforeAll(async () => {
  vi.stubGlobal('crypto', webcrypto);
  client = createClient({ url: ':memory:' });
  identity.db = createTursoDatabase(client);
  await initializeAutoSellRunStorageFixture(identity.db);
  const f = await setupAutoSellRunStorageFixture(identity.db, {
    owner: identity.owner,
  });
  const run = await createOwnedAutoSellRun(
    identity.db,
    identity.owner,
    f.createInput,
    new AbortController().signal,
  );
  const a = await reserveOwnedAutoSellAttempt(
    identity.db,
    identity.owner,
    autoSellRunAttemptFixture(run),
    new AbortController().signal,
  );
  await startOwnedAutoSellPreparation(
    identity.db,
    identity.owner,
    run.id,
    a.id,
    new AbortController().signal,
  );
  const response = await GET(
    new Request(
      'https://bundle.test/api/imported-projects/auto-sell-run-progress?' +
        new URLSearchParams({ projectId: f.projectId, runId: run.id }),
    ),
  );
  expect(response.status).toBe(200);
  body = (await response.json()) as Record<string, unknown>;
  initial = {
    owner: identity.owner,
    projectId: f.projectId,
    run: {
      id: run.id,
      runSha256: run.sha256,
      attemptCount: 1,
      accountedRaw: a.inputRaw,
      stopped: false,
    },
    disabled: false,
    onObserved: observed,
  };
});
afterAll(() => client.close());
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', {
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    subtle: {
      digest: async (
        _algorithm: unknown,
        data: ArrayBuffer | ArrayBufferView,
      ) =>
        Uint8Array.from(
          createHash('sha256')
            .update(
              ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data),
            )
            .digest(),
        ).buffer,
    },
  });
  requests = [];
  observed.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({ url, init, resolve }),
        ),
    ),
  );
  props = { ...initial, run: { ...initial.run } };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <AutoSellRunProgressPanel
        key={[
          props.owner,
          props.projectId,
          props.run.id,
          props.run.runSha256,
        ].join(':')}
        {...props}
      />,
    ),
  );
}
async function open() {
  await render();
  await act(async () => {
    const d = host.querySelector('details')!;
    d.open = true;
    d.dispatchEvent(new Event('toggle', { bubbles: true }));
  });
}
function button(label: string) {
  const b = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === label,
  );
  if (!b) throw Error('Missing ' + label);
  return b;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function reply(i: number, value = structuredClone(body), status = 200) {
  await act(async () => requests[i].resolve(Response.json(value, { status })));
}
async function load() {
  await open();
  await click('Load complete saved progress');
  await reply(0);
}
it('does not read on mount or open and exposes no financial or resume action', async () => {
  await open();
  expect(requests).toHaveLength(0);
  expect(host.textContent).toContain('never starts or resumes');
  expect(host.querySelector('input')).toBeNull();
  expect(host.textContent).not.toContain('tokens sold:');
});
it('derives charged allowance and unavailable sales from actual API evidence', async () => {
  await load();
  expect(requests).toHaveLength(1);
  expect(requests[0].init?.method).toBe('GET');
  expect(observed).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('10 tokens across 1 attempts');
  expect(host.textContent).toContain('Unavailable from this journal');
  expect(host.textContent).toContain('Historical unsaved queues');
  expect(host.textContent).toContain('preparation');
  expect(host.querySelector('input')).toBeNull();
});
it('keeps previous complete evidence visible when a refresh refuses malformed input', async () => {
  await load();
  await click('Refresh complete saved progress');
  await reply(1, { ...body, evidence: {} });
  expect(
    host.querySelector('[aria-label="Verified original run progress"]'),
  ).not.toBeNull();
  expect(host.textContent).toContain('10 tokens across 1 attempts');
  expect(host.querySelector('[role=alert]')).not.toBeNull();
  expect(observed).toHaveBeenCalledOnce();
});
it('refuses a preparation-start disappearance on refresh and retains the prior observation', async () => {
  await load();
  const altered = structuredClone(body) as typeof body & {
    evidence: { preparationStarts: unknown[] };
  };
  altered.evidence.preparationStarts = [];
  await click('Refresh complete saved progress');
  await reply(1, altered);
  expect(host.querySelector('[role=alert]')).not.toBeNull();
  expect(observed).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('10 tokens across 1 attempts');
});
it('stops waiting and ignores an uncooperative late response', async () => {
  await open();
  await click('Load complete saved progress');
  const signal = requests[0].init?.signal;
  await click('Stop progress check');
  expect(signal?.aborted).toBe(true);
  await reply(0);
  expect(observed).not.toHaveBeenCalled();
  expect(
    host.querySelector('[aria-label="Verified original run progress"]'),
  ).toBeNull();
  expect(host.textContent).toContain('Waiting stopped');
});
it('aborts on close and reopening never reloads automatically', async () => {
  await open();
  await click('Load complete saved progress');
  await act(async () => {
    const d = host.querySelector('details')!;
    d.open = false;
    d.dispatchEvent(new Event('toggle', { bubbles: true }));
  });
  expect(requests[0].init?.signal?.aborted).toBe(true);
  await reply(0);
  expect(observed).not.toHaveBeenCalled();
  await act(async () => {
    const d = host.querySelector('details')!;
    d.open = true;
    d.dispatchEvent(new Event('toggle', { bubbles: true }));
  });
  expect(requests).toHaveLength(1);
  expect(
    host.querySelector('[aria-label="Verified original run progress"]'),
  ).toBeNull();
});
it('aborts pending progress when the parent starts another operation', async () => {
  await open();
  await click('Load complete saved progress');
  props = { ...props, disabled: true };
  await render();
  expect(requests[0].init?.signal?.aborted).toBe(true);
  await reply(0);
  expect(observed).not.toHaveBeenCalled();
  expect(button('Load complete saved progress').disabled).toBe(true);
});
it('clears prior evidence and cancels reads on owner changes', async () => {
  await load();
  props = { ...props, owner: 'other-owner' };
  await render();
  expect(
    host.querySelector('[aria-label="Verified original run progress"]'),
  ).toBeNull();
  expect(requests).toHaveLength(1);
});
it('clears prior evidence on another run selection', async () => {
  await load();
  props = {
    ...props,
    run: { ...props.run, id: '00000000-0000-4000-8000-000000000099' },
  };
  await render();
  expect(
    host.querySelector('[aria-label="Verified original run progress"]'),
  ).toBeNull();
});
it('does not accept progress refused by the parent observation floor', async () => {
  observed.mockImplementation(() => {
    throw Error('History moved backwards.');
  });
  await open();
  await click('Load complete saved progress');
  await reply(0);
  expect(
    host.querySelector('[aria-label="Verified original run progress"]'),
  ).toBeNull();
  expect(host.textContent).toContain('History moved backwards.');
});
it('shows bounded capacity refusal without accepting partial progress or raw errors', async () => {
  await open();
  await click('Load complete saved progress');
  await reply(0, { error: 'secret parser' }, 409);
  expect(host.textContent).toContain('paged saved attempts');
  expect(host.textContent).not.toContain('secret parser');
  expect(observed).not.toHaveBeenCalled();
});
