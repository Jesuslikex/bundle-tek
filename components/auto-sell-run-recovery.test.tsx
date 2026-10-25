// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import { setupAutoSellRunPacketStorageFixture } from '@/test/auto-sell-run-packet-storage-fixture';
import { saveSwapPreparation } from '@/lib/imported-swap-preparation-history';
import { profileProject } from '@/test/auto-sell-profile-fixture';
const identity = vi.hoisted(() => ({
  owner: 'recovery-owner' as string | null,
  pending: false,
  apiOwner: 'recovery-owner',
  db: null as unknown as D1Database,
}));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({
      data: identity.owner ? { user: { id: identity.owner } } : null,
      isPending: identity.pending,
    }),
  }),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: identity.apiOwner }),
}));
vi.mock('@/db', () => ({ getD1: () => identity.db }));
import { GET as journalGET } from '@/app/api/imported-projects/auto-sell-runs/route';
import { GET as packetGET } from '@/app/api/imported-projects/auto-sell-run-recovery/route';
import { AutoSellRunRecovery } from './auto-sell-run-recovery';
let client: Client;
let f: Awaited<ReturnType<typeof setupAutoSellRunPacketStorageFixture>>;
let indexBody: Record<string, unknown>,
  pageBody: Record<string, unknown>,
  packetBody: Record<string, unknown>;
let root: Root, host: HTMLDivElement, project: typeof profileProject;
let requests: {
  url: string;
  init?: RequestInit;
  resolve: (response: Response) => void;
}[];
beforeAll(async () => {
  vi.stubGlobal('crypto', webcrypto);
  client = createClient({ url: ':memory:' });
  identity.db = createTursoDatabase(client);
  for (const entry of JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ).entries)
    await client.executeMultiple(
      readFileSync('drizzle/' + entry.tag + '.sql', 'utf8'),
    );
  f = await setupAutoSellRunPacketStorageFixture(identity.db, {
    owner: identity.apiOwner,
  });
  await saveSwapPreparation(
    identity.db,
    f.owner,
    f.context,
    f.summary,
    undefined,
    undefined,
    undefined,
    f.guard!,
    f.transaction,
  );
  indexBody = (await (
    await journalGET(
      new Request(
        'https://bundle.test/api/imported-projects/auto-sell-runs?' +
          new URLSearchParams({ projectId: f.projectId, index: '1' }),
      ),
    )
  ).json()) as Record<string, unknown>;
  pageBody = (await (
    await journalGET(
      new Request(
        'https://bundle.test/api/imported-projects/auto-sell-runs?' +
          new URLSearchParams({ runId: f.run.id, attempts: '1' }),
      ),
    )
  ).json()) as Record<string, unknown>;
  packetBody = (await (
    await packetGET(
      new Request(
        'https://bundle.test/api/imported-projects/auto-sell-run-recovery?' +
          new URLSearchParams({ runId: f.run.id, attemptId: f.attempt.id }),
      ),
    )
  ).json()) as Record<string, unknown>;
});
afterAll(() => client.close());
beforeEach(() => {
  identity.owner = 'recovery-owner';
  identity.pending = false;
  requests = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', {
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    subtle: {
      digest: async (
        _algorithm: unknown,
        data: ArrayBuffer | ArrayBufferView,
      ) => {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        return Uint8Array.from(createHash('sha256').update(bytes).digest())
          .buffer;
      },
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({ url, init, resolve }),
        ),
    ),
  );
  project = structuredClone(profileProject);
  project.id = f.projectId;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  for (const request of requests) expect(request.init?.method).toBe('GET');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const render = async (open = true) => {
  await act(async () => root.render(<AutoSellRunRecovery project={project} />));
  const details = host.querySelector('details')!;
  if (open && !details.open)
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
};
const button = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  )!;
const click = async (label: string) => {
  expect(button(label)).toBeDefined();
  await act(async () => button(label).click());
};
const reply = async (i: number, body: unknown, status = 200) => {
  await act(async () => requests[i].resolve(Response.json(body, { status })));
};
const waitText = async (text: string) => {
  await act(async () => {
    await vi.waitFor(() => expect(host.textContent).toContain(text));
  });
};
async function inspect() {
  await render();
  await click('Load saved runs');
  await reply(0, indexBody);
  await click('Inspect run ' + f.run.id.slice(0, 8) + '…' + f.run.id.slice(-4));
  await reply(1, pageBody);
}

it('does not fetch journal records on mount or disclosure, and keeps reads separate from the tab-only runner', async () => {
  await render(false);
  await act(async () => host.querySelector('summary')!.click());
  expect(requests).toHaveLength(0);
  expect(host.textContent).toContain('Current tab-only runs are not recorded');
  expect(host.querySelector('input')).toBeNull();
});
it('composes actual saved API responses through index, attempts and exact-packet admission', async () => {
  await inspect();
  expect(requests).toHaveLength(2);
  await click('Inspect preparation #1');
  await reply(2, packetBody);
  await waitText('Original unsigned preparation retained');
  expect(host.textContent).toContain('No allowance has been released');
  expect(
    host.querySelector(`time[datetime="${f.summary.expiresAt}"]`),
  ).not.toBeNull();
  expect(host.textContent).toContain('not a finalized receipt');
  expect(host.textContent).not.toContain(f.transaction);
  expect(host.querySelector('input')).toBeNull();
  expect(document.activeElement?.textContent).toBe('Preparation #1');
  await click('Back to attempts');
  expect(requests).toHaveLength(3);
  await click('Back to saved runs');
  expect(requests).toHaveLength(3);
});
it.each(['started-without-result', 'summary-only'] as const)(
  'shows %s without a resume or retry-write action',
  async (status) => {
    await inspect();
    await click('Inspect preparation #1');
    await reply(2, {
      ...packetBody,
      status,
      packet: null,
      summary: status === 'summary-only' ? packetBody.summary : null,
    });
    await waitText(
      status === 'summary-only'
        ? 'Summary only: packet not retained'
        : 'Preparation outcome unknown',
    );
    expect(host.textContent).toContain('original input remains charged');
    expect(
      [...host.querySelectorAll('button')].some((b) =>
        /^(Resume|Start|Sign|Send|Restore|Release)/.test(b.textContent ?? ''),
      ),
    ).toBe(false);
  },
);
it('admits a genuinely not-started projection without calling it settled', async () => {
  await render();
  await click('Load saved runs');
  await reply(0, indexBody);
  await click('Inspect run ' + f.run.id.slice(0, 8) + '…' + f.run.id.slice(-4));
  const page = structuredClone(pageBody) as {
    attempts: { preparationStarted: boolean }[];
  };
  page.attempts[0].preparationStarted = false;
  await reply(1, page);
  await click('Inspect preparation #1');
  await reply(2, {
    ...packetBody,
    status: 'not-started',
    packet: null,
    summary: null,
  });
  await waitText('Preparation not started');
  expect(host.textContent).toContain('This screen cannot start or resume it');
});
it('rejects true authority or corrupted packet evidence instead of displaying a retained success', async () => {
  await inspect();
  await click('Inspect preparation #1');
  await reply(2, { ...packetBody, signingAllowed: true });
  await waitText('Saved Auto Sell recovery is unavailable');
  expect(host.textContent).not.toContain(
    'Original unsigned preparation retained',
  );
  expect(host.textContent).toContain(f.attempt.preparationId);
});
it('sanitizes an HTML error and allows another explicit GET without releasing anything', async () => {
  await render();
  await click('Load saved runs');
  await act(async () =>
    requests[0].resolve(
      new Response('<html>PRIVATE-PARSER-SECRET</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  await waitText('Saved Auto Sell recovery is unavailable');
  expect(host.textContent).not.toContain('PRIVATE-PARSER-SECRET');
  await click('Load saved runs');
  await reply(1, indexBody);
  expect(requests).toHaveLength(2);
});
it('cancels pending reads and refuses their late replies without changing saved allowance', async () => {
  await render();
  await click('Load saved runs');
  await click('Stop waiting');
  expect(requests[0].init?.signal?.aborted).toBe(true);
  await reply(0, indexBody);
  expect(host.textContent).not.toContain('reserved attempt');
  expect(host.textContent).toContain('charged allowance are unchanged');
});
it.each(['owner', 'project', 'sign-out'] as const)(
  'clears old evidence synchronously when %s changes and ignores late results',
  async (change) => {
    await inspect();
    await click('Inspect preparation #1');
    if (change === 'owner') identity.owner = 'another-owner';
    if (change === 'sign-out') identity.owner = null;
    if (change === 'project') project = { ...project, id: crypto.randomUUID() };
    await render();
    expect(requests[2].init?.signal?.aborted).toBe(true);
    await reply(2, packetBody);
    expect(host.textContent).not.toContain(f.attempt.preparationId);
    expect(host.textContent).not.toContain(
      'Original unsigned preparation retained',
    );
  },
);
it('keeps journal controls disabled while signed out or checking identity', async () => {
  identity.owner = null;
  await render();
  expect(button('Load saved runs').disabled).toBe(true);
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/sign-in');
  identity.owner = 'recovery-owner';
  identity.pending = true;
  await render();
  expect(button('Load saved runs').disabled).toBe(true);
  expect(requests).toHaveLength(0);
});

it('clears previously read evidence while identity becomes uncertain', async () => {
  await inspect();
  identity.pending = true;
  await render();
  expect(host.textContent).not.toContain(f.attempt.preparationId);
  expect(host.textContent).not.toContain('reserved attempts');
  expect(button('Load saved runs').disabled).toBe(true);
});

it.each(['count', 'amount', 'stop'] as const)(
  'retains observed allowance and Stop floors across an index reload (%s)',
  async (fault) => {
    await render();
    await click('Load saved runs');
    const initial = structuredClone(indexBody) as {
      runs: { attemptCount: number; accountedRaw: string; stopped: boolean }[];
    };
    if (fault === 'stop') initial.runs[0].stopped = true;
    await reply(0, initial);
    const stale = structuredClone(initial);
    if (fault === 'count') {
      stale.runs[0].attemptCount = 0;
      stale.runs[0].accountedRaw = '0';
    }
    if (fault === 'amount') stale.runs[0].accountedRaw = '999';
    if (fault === 'stop') stale.runs[0].stopped = false;
    await click('Load saved runs');
    await reply(1, stale);
    await waitText('Saved run history moved backwards');
    expect(host.textContent).toContain('1000 raw token units remain charged');
    if (fault === 'stop') expect(host.textContent).toContain('Journal stopped');
  },
);

it('advances the cached attempt marker after its original preparation is recovered', async () => {
  await render();
  await click('Load saved runs');
  await reply(0, indexBody);
  await click('Inspect run ' + f.run.id.slice(0, 8) + '…' + f.run.id.slice(-4));
  const before = structuredClone(pageBody) as {
    attempts: { preparationStarted: boolean }[];
  };
  before.attempts[0].preparationStarted = false;
  await reply(1, before);
  expect(host.textContent).toContain('Not started');
  await click('Inspect preparation #1');
  await reply(2, packetBody);
  await waitText('Original unsigned preparation retained');
  await click('Back to attempts');
  expect(host.textContent).toContain('Preparation start recorded');
  expect(host.textContent).not.toContain('Not started');
});
