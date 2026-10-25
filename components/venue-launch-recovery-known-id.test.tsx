// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  VenueLaunchRecoveryHistory,
  useVenueLaunchRecovery,
} from './venue-launch-recovery';

const savedId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const mint = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const venues = ['meteora-dbc', 'stonkfun', 'launchlab'] as const;
type Venue = (typeof venues)[number];
let root: Root, container: HTMLDivElement;
const fetcher = vi.fn();

function saved(venue: Venue, projectId = 'project-a', id = savedId) {
  return {
    format: 'venue-launch-recovery-v1',
    id,
    venue,
    projectId,
    state: 'finalized',
    signature: '1'.repeat(64),
    receipt: null,
    createdAt: '2026-10-23T00:00:00.000Z',
    review: {
      format:
        venue === 'meteora-dbc'
          ? 'meteora-dbc-launch-review-v1'
          : venue === 'stonkfun'
            ? 'stonkfun-launch-review-v1'
            : 'launchlab-launch-review-v1',
      terms: { projectId, mint, venue: 'LetsBonk' },
      input: {
        mint,
        name: 'Older saved launch',
        symbol: 'OLD',
        venue: 'LetsBonk',
      },
      transaction: 'unsigned-fixture',
      sha256: 'a'.repeat(64),
      expiresAt: '2026-10-23T00:00:45.000Z',
      summary: {
        quoteDecimals: 9,
        devSupplyBps: 0,
        devBuyRaw: '0',
        tokensOutRaw: '0',
        solCostLamports: '10000',
        pool: mint,
        quoteSymbol: 'SOL',
        migrationThresholdRaw: '1000000000',
        poolCreationFeeLamports: '0',
        baseDecimals: 6,
        raiseRaw: '1000000000',
        supplyRaw: '1000000000',
        venue: 'LetsBonk',
      },
    },
  };
}

function Harness({
  venue,
  projectId = 'project-a',
  busy = false,
}: {
  venue: Venue;
  projectId?: string;
  busy?: boolean;
}) {
  const recovery = useVenueLaunchRecovery(venue, projectId);
  const [error, setError] = useState('');
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <VenueLaunchRecoveryHistory
        recovery={recovery}
        busy={busy}
        onTask={(task) => {
          setError('');
          void task().catch((e) =>
            setError(e instanceof Error ? e.message : 'Read failed.'),
          );
        }}
      />
    </>
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve();
  });
}
async function render(venue: Venue, projectId = 'project-a', busy = false) {
  await act(async () =>
    root.render(
      <Harness
        key={venue + projectId}
        venue={venue}
        projectId={projectId}
        busy={busy}
      />,
    ),
  );
  await settle();
}
function lookupInput() {
  const label = [...container.querySelectorAll('label')].find((e) =>
    /saved launch id/i.test(e.textContent ?? ''),
  );
  const input =
    label?.querySelector('input') ??
    (label?.htmlFor
      ? container.querySelector<HTMLInputElement>('#' + label.htmlFor)
      : null);
  if (!input) throw Error('Missing saved launch ID input');
  return input;
}
async function typeId(value: string) {
  await act(async () => {
    const input = lookupInput();
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function open() {
  const button = [...container.querySelectorAll('button')].find((e) =>
    e.textContent?.includes('Open saved launch by ID'),
  );
  if (!button) throw Error('Missing open-by-ID button');
  await act(async () => button.click());
  await settle();
}
function exactRequests() {
  return fetcher.mock.calls.filter(([url]) => String(url).includes('?id='));
}
function onlyReads() {
  expect(
    fetcher.mock.calls.every(
      ([, init]) => !init?.method || init.method === 'GET',
    ),
  ).toBe(true);
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  fetcher.mockReset().mockImplementation(async (url: string) => {
    const venue = venues.find((v) => url.includes('/' + v + '/'))!;
    return Response.json(
      url.includes('?projectId=') ? { launches: [] } : saved(venue),
    );
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

for (const venue of venues) {
  it(`${venue}: opens an older known ID absent from the recent history with one exact GET only`, async () => {
    await render(venue);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(container.textContent).toMatch(/20/);
    await typeId(savedId);
    expect(exactRequests()).toHaveLength(0);
    await open();
    expect(exactRequests()).toHaveLength(1);
    expect(exactRequests()[0][0]).toBe(`/api/${venue}/launch?id=${savedId}`);
    expect(container.textContent).toContain('Saved launch status: finalized');
    expect(container.textContent).toContain('Older saved launch');
    expect(container.querySelector('input[type="password"]')).toBeNull();
    onlyReads();
  });

  for (const mismatch of ['project', 'venue', 'id'] as const) {
    it(`${venue}: refuses a mismatched ${mismatch} without replacing the selected launch`, async () => {
      await render(venue);
      await typeId(savedId);
      await open();
      fetcher.mockImplementation(async () =>
        Response.json({
          ...saved(
            venue,
            mismatch === 'project' ? 'other-project' : 'project-a',
            mismatch === 'id' ? savedId : otherId,
          ),
          ...(mismatch === 'venue'
            ? { venue: venue === 'stonkfun' ? 'meteora-dbc' : 'stonkfun' }
            : {}),
        }),
      );
      await typeId(otherId);
      await open();
      expect(container.textContent).toContain('Saved launch status: finalized');
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(exactRequests()).toHaveLength(2);
      onlyReads();
    });
  }

  it(`${venue}: retains a failed lookup for a manual retry and explains sign-in`, async () => {
    await render(venue);
    fetcher.mockResolvedValue(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    await typeId(savedId);
    await open();
    expect(container.textContent).toContain('Sign in');
    expect(lookupInput().value).toBe(savedId);
    expect(exactRequests()).toHaveLength(1);
    await settle();
    expect(exactRequests()).toHaveLength(1);
    onlyReads();
  });

  it(`${venue}: preserves the known unresolved original instead of reading another ID`, async () => {
    localStorage.setItem(
      `bundle-venue-launch-recovery:${venue}:project-a`,
      JSON.stringify({ id: savedId, stage: 'submit' }),
    );
    await render(venue);
    await typeId(otherId);
    await open();
    expect(exactRequests()).toHaveLength(0);
    expect(container.textContent).toContain('original');
    expect(
      JSON.parse(
        localStorage.getItem(
          `bundle-venue-launch-recovery:${venue}:project-a`,
        )!,
      ).id,
    ).toBe(savedId);
    onlyReads();
  });
}

it.each([
  '',
  'abc',
  'https://example.test/?id=' + savedId,
  '1'.repeat(500),
  savedId.replace('-4111-', '-9111-'),
])('rejects invalid ID %s before any exact read', async (id) => {
  await render('meteora-dbc');
  await typeId(id);
  await open();
  expect(exactRequests()).toHaveLength(0);
  onlyReads();
});

it('disables exact opening while the parent is busy', async () => {
  await render('stonkfun', 'project-a', true);
  await typeId(savedId);
  await open();
  expect(exactRequests()).toHaveLength(0);
});

it('resets the manual draft when the context key changes even with no records', async () => {
  const select = vi.fn();
  const recovery = {
    contextKey: 'meteora-dbc:project-a',
    record: null,
    history: [],
    loading: false,
    error: '',
    uncertain: false,
    originalId: '',
    load: vi.fn(),
    select,
    recover: vi.fn(),
    write: vi.fn(),
  };
  const onTask = vi.fn();
  await act(async () =>
    root.render(
      <VenueLaunchRecoveryHistory
        recovery={recovery}
        busy={false}
        onTask={onTask}
      />,
    ),
  );
  await typeId(savedId);
  await act(async () =>
    root.render(
      <VenueLaunchRecoveryHistory
        recovery={{ ...recovery, contextKey: 'stonkfun:project-b' }}
        busy={false}
        onTask={onTask}
      />,
    ),
  );
  expect(lookupInput().value).toBe('');
  expect(select).not.toHaveBeenCalled();
  expect(onTask).not.toHaveBeenCalled();
});

it('Enter in the lookup field cannot submit the containing launch form', async () => {
  const submitted = vi.fn();
  await act(async () =>
    root.render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitted();
        }}
      >
        <Harness venue="meteora-dbc" />
      </form>,
    ),
  );
  await settle();
  await typeId(savedId);
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => lookupInput().dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(submitted).not.toHaveBeenCalled();
  expect(exactRequests()).toHaveLength(0);
});

it('does not retry a missing owned saved record automatically', async () => {
  await render('launchlab');
  fetcher.mockResolvedValue(
    Response.json({ error: 'Saved launch not found.' }, { status: 404 }),
  );
  await typeId(savedId);
  await open();
  expect(container.textContent).toContain('Saved launch not found.');
  expect(lookupInput().value).toBe(savedId);
  await settle();
  expect(exactRequests()).toHaveLength(1);
  onlyReads();
});

it('blocks exact reads until initial history loading has completed', async () => {
  let resolve!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  await render('meteora-dbc');
  expect(lookupInput().disabled).toBe(true);
  await open();
  expect(exactRequests()).toHaveLength(0);
  await act(async () => resolve(Response.json({ launches: [] })));
  await settle();
  expect(lookupInput().disabled).toBe(false);
});

it.each([401, 503])(
  'keeps history uncertainty after an initial %s and refuses manual ID opening',
  async (status) => {
    fetcher.mockResolvedValueOnce(
      Response.json({ error: 'History unavailable.' }, { status }),
    );
    await render('meteora-dbc');
    await typeId(savedId);
    await open();
    expect(exactRequests()).toHaveLength(0);
    expect(container.textContent).toContain(
      'Reload saved launches to verify the history',
    );
    expect(container.textContent).toContain(
      'A launch action may have been saved',
    );
    onlyReads();
  },
);

it('requires fresh history rather than clearing a lost preparation with an older terminal ID', async () => {
  localStorage.setItem(
    'bundle-venue-launch-recovery:stonkfun:project-a',
    JSON.stringify({ id: '', stage: 'prepare' }),
  );
  await render('stonkfun');
  await typeId(savedId);
  await open();
  expect(exactRequests()).toHaveLength(0);
  expect(container.textContent).toContain(
    'Reload saved launches to verify the history',
  );
  expect(
    localStorage.getItem('bundle-venue-launch-recovery:stonkfun:project-a'),
  ).toContain('prepare');
  onlyReads();
});

it('does not read an unmounted request response into another project', async () => {
  await render('meteora-dbc');
  let resolve!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  await typeId(savedId);
  await open();
  const signal = exactRequests()[0][1].signal as AbortSignal;
  await render('stonkfun', 'project-b');
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(Response.json(saved('meteora-dbc'))));
  await settle();
  expect(container.textContent).not.toContain('Saved launch status: finalized');
  expect(lookupInput().value).toBe('');
  onlyReads();
});

it('keeps stale history rows disabled after a failed reload until history is verified again', async () => {
  fetcher.mockResolvedValueOnce(
    Response.json({ launches: [saved('meteora-dbc')] }),
  );
  await render('meteora-dbc');
  fetcher.mockResolvedValueOnce(
    Response.json(
      { error: 'History temporarily unavailable.' },
      { status: 503 },
    ),
  );
  const reload = [...container.querySelectorAll('button')].find(
    (e) => e.textContent === 'Reload saved launches',
  )!;
  await act(async () => reload.click());
  await settle();
  const row = [...container.querySelectorAll('button')].find((e) =>
    e.textContent?.includes('finalized · Older saved launch'),
  )!;
  expect(row.disabled).toBe(true);
  await act(async () => row.click());
  await typeId(savedId);
  await open();
  expect(exactRequests()).toHaveLength(0);
  expect(container.textContent).toContain('History temporarily unavailable.');
  await act(async () => reload.click());
  await settle();
  await open();
  expect(exactRequests()).toHaveLength(1);
  onlyReads();
});
