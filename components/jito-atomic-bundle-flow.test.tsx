// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act, Activity, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JitoAtomicBundle } from './jito-atomic-bundle';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import type { TradeSession } from '@/lib/imported-trade-session';
import type { JitoBundleRecord } from '@/lib/jito-bundle';
import { bundleFingerprint } from '@/lib/jito-bundle';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({ data: { user: { id: 'alice' } }, isPending: false }),
  }),
}));
vi.mock('./jito-packet-signing', () => ({
  JitoPacketSigning: ({
    disabled,
    packet,
    ownerScope,
    manifest,
    coordinator,
    registerEvidence,
  }: {
    disabled: boolean;
    packet: number;
    ownerScope: string;
    manifest: JitoBundleRecord['manifest'];
    coordinator: {
      startOperation: (owner: string, id: string, packet: number) => object;
      finishOperation: (token: object) => void;
    };
    registerEvidence: (
      transaction: string,
      attemptId: string,
      token: object,
    ) => Promise<void>;
  }) => (
    <p data-testid="mock-signer" data-disabled={String(disabled)}>
      Explicit packet signing
      {packet === 0 && journal.evidence && (
        <button
          onClick={() => {
            const token = coordinator.startOperation(
              ownerScope,
              manifest.id,
              packet,
            );
            void registerEvidence(
              journal.evidence!.transaction,
              journal.evidence!.attemptId,
              token,
            )
              .catch(() => {
                journal.evidenceFailed = true;
              })
              .finally(() => coordinator.finishOperation(token));
          }}
        >
          Register mock evidence
        </button>
      )}
    </p>
  ),
}));
const journal = vi.hoisted(() => ({
  pending: [] as Array<{
    bundleId: string;
    packet: number;
    status: 'unknown' | 'retained';
  }>,
  evidence: null as null | { transaction: string; attemptId: string },
  evidenceFailed: false,
}));
vi.mock('@/lib/jito-recovery-journal', () => ({
  withJitoRecoveryJournalLock: async (
    _owner: string,
    guard: () => void,
    body: (lock: object) => Promise<unknown>,
  ) => {
    guard();
    return body({});
  },
  listJitoRecoveryJournalPending: async (
    _lock: object,
    _project: string,
    _session: string,
    readOwner: () => Promise<string>,
  ) => {
    await readOwner();
    await readOwner();
    return journal.pending;
  },
}));
let root: Root, container: HTMLDivElement;
const fetcher = vi.fn();
beforeEach(() => {
  journal.pending = [];
  journal.evidence = null;
  journal.evidenceFailed = false;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function fixture() {
  const f = await jitoBundleFixture();
  const session: TradeSession = {
    id: f.manifest.sessionId,
    revision: f.manifest.sessionRevision,
    state: 'active',
    createdAt: f.manifest.createdAt,
    updatedAt: f.manifest.createdAt,
    terms: {
      format: 'imported-trade-session-v1',
      projectId: f.manifest.projectId,
      projectRevision: 1,
      mint: f.review.outputMint,
      decimals: 6,
      side: 'Buy',
      totalRaw: f.review.inputRaw,
      entries: [
        {
          entry: 1,
          wallet: f.review.wallet,
          walletRevision: 1,
          unitsRaw: f.review.inputRaw,
          amount: '0.01',
        },
      ],
    },
  };
  const bundle: JitoBundleRecord = {
    manifest: f.manifest,
    state: 'reviewed',
    bundleId: null,
    signatures: [f.swap.signed.signature, f.tip.signed.signature],
    updatedAt: f.manifest.createdAt,
    finalization: null,
  };
  const history = {
    projectId: f.manifest.projectId,
    sessionId: session.id,
    eligible: [],
    bundles: [bundle],
  };
  return { f, session, bundle, history };
}
function exact(
  f: Awaited<ReturnType<typeof jitoBundleFixture>>,
  bundle: JitoBundleRecord,
) {
  return {
    projectId: bundle.manifest.projectId,
    sessionId: bundle.manifest.sessionId,
    bundle,
    legacyReadOnly: false,
    attempts: bundle.signatures.flatMap((signature, packet) =>
      signature
        ? [
            {
              bundleId: bundle.manifest.id,
              manifestSha256: bundle.manifest.sha256,
              packet,
              attemptId:
                packet === 0
                  ? '11111111-1111-4111-8111-111111111111'
                  : '22222222-2222-4222-8222-222222222222',
              signer:
                bundle.manifest.swaps[packet]?.wallet ??
                bundle.manifest.tip.wallet,
              intentId: bundle.manifest.swaps[packet]?.id ?? null,
              transaction:
                packet === 0
                  ? f.swap.signed.transaction
                  : f.tip.signed.transaction,
              signature,
              state: 'registered',
            },
          ]
        : [],
    ),
  };
}
async function render(session: TradeSession, locked = false) {
  await act(async () =>
    root.render(
      <JitoAtomicBundle
        projectId={session.terms.projectId}
        session={session}
        locked={locked}
      />,
    ),
  );
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).not.toContain(
      'Sign in and reload bundle history to verify the current account.',
    );
    expect(container.textContent).not.toContain(
      'Checking the signed-in account',
    );
    expect(button('Load bundle approvals').disabled).toBe(false);
  });
}
function button(text: string) {
  const value = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
  if (!value)
    throw Error('Missing button ' + text + ':' + container.textContent);
  return value;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
it('keeps every new signer disabled even for a fresh verified unsigned plan while allowing read-only checks', async () => {
  const { f, session, bundle, history } = await fixture();
  bundle.signatures = [null, null];
  const scope = await jitoOwnerScope('alice');
  fetcher.mockImplementation(async (url, init) => {
    expect(init?.method).not.toBe('POST');
    return Response.json(
      String(url).includes('bundleId=') ? exact(f, bundle) : history,
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(button('Check sequential simulation').disabled).toBe(false);
  });
  const signers = [
    ...container.querySelectorAll('[data-testid="mock-signer"]'),
  ];
  expect(signers).toHaveLength(2);
  expect(
    signers.every((node) => node.getAttribute('data-disabled') === 'true'),
  ).toBe(true);
  expect(container.textContent).toContain('New Jito signing is disabled');
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it('disables unqualified submission and still recovers a prior ambiguous outcome', async () => {
  const { f, session, bundle, history } = await fixture();
  const scope = await jitoOwnerScope('alice');
  const posts: string[] = [];
  fetcher.mockImplementation(async (url, init) => {
    if (!init?.method)
      return Response.json(
        String(url).includes('bundleId=') ? exact(f, bundle) : history,
        {
          headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
        },
      );
    const action = JSON.parse(init.body).action;
    posts.push(action);
    if (action === 'submit') {
      bundle.state = 'submitting';
      throw Error('Lost reply');
    }
    return Response.json(
      { bundle },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  expect(fetcher).not.toHaveBeenCalled();
  await click('Load bundle approvals');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain('Bundle ' + bundle.manifest.id);
  });
  expect(button('Submit complete Jito bundle').disabled).toBe(true);
  const approval = [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('I approve submitting'))!
    .querySelector('input')!;
  expect(approval.checked).toBe(false);
  expect(approval.disabled).toBe(true);
  await act(async () => approval.click());
  expect(container.textContent).toContain(
    'Submission is unavailable until these exact signed transactions',
  );
  expect(button('Submit complete Jito bundle').disabled).toBe(true);
  await click('Submit complete Jito bundle');
  expect(posts).toEqual([]);
  // A submitting record may predate this gate; it remains recoverable.
  bundle.state = 'submitting';
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(button('Check chain outcomes').disabled).toBe(false),
  );
  await click('Check chain outcomes');
  await vi.waitFor(() => expect(posts).toEqual(['recover']));
  expect(container.textContent).toContain('Submission outcome unknown');
  expect(container.textContent).not.toContain('Submit complete Jito bundle');
});

it('shows only bound provider-reported packet outcomes, then clears them on history refresh', async () => {
  const { f, session, bundle, history } = await fixture();
  bundle.state = 'submitted';
  bundle.bundleId = 'ab'.repeat(32);
  const scope = await jitoOwnerScope('alice');
  const posts: string[] = [];
  const chainObservation = {
    format: 'jito-chain-observation-v1',
    bundleId: bundle.manifest.id,
    bundleSha256: bundle.manifest.sha256,
    state: 'submitted',
    observedAt: '2026-10-28T12:00:00.000Z',
    packets: [
      {
        packet: 0,
        signature: bundle.signatures[0],
        status: 'finalized-failure',
        slot: 300,
      },
      {
        packet: 1,
        signature: bundle.signatures[1],
        status: 'not-found',
        slot: null,
      },
    ],
  };
  fetcher.mockImplementation(async (url, init) => {
    if (!init?.method)
      return Response.json(
        String(url).includes('bundleId=') ? exact(f, bundle) : history,
        {
          headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
        },
      );
    posts.push(JSON.parse(init.body).action);
    return Response.json(
      { bundle, chainObservation },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(button('Check chain outcomes').disabled).toBe(false),
  );
  await click('Check chain outcomes');
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Finalized, failure reported'),
  );
  expect(container.textContent).toContain('Not found by this provider');
  expect(container.textContent).toContain(
    'not verified settlement receipts or proof',
  );
  expect(posts).toEqual(['recover']);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(container.textContent).not.toContain(
      'Provider-reported packet outcomes',
    ),
  );
  expect(posts).toEqual(['recover']);
});

it('does not display a provider report rebound to another packet or bundle', async () => {
  const { f, session, bundle, history } = await fixture();
  bundle.state = 'submitted';
  bundle.bundleId = 'ab'.repeat(32);
  const scope = await jitoOwnerScope('alice');
  fetcher.mockImplementation(async (url, init) => {
    if (!init?.method)
      return Response.json(
        String(url).includes('bundleId=') ? exact(f, bundle) : history,
        {
          headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
        },
      );
    return Response.json(
      {
        bundle,
        chainObservation: {
          format: 'jito-chain-observation-v1',
          bundleId: bundle.manifest.id,
          bundleSha256: bundle.manifest.sha256,
          state: 'submitted',
          observedAt: '2026-10-28T12:00:00.000Z',
          packets: [
            {
              packet: 0,
              signature: 'different',
              status: 'finalized-success',
              slot: 300,
            },
            {
              packet: 1,
              signature: bundle.signatures[1],
              status: 'not-found',
              slot: null,
            },
          ],
        },
      },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(button('Check chain outcomes').disabled).toBe(false),
  );
  await click('Check chain outcomes');
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      'Provider outcome details were unavailable',
    ),
  );
  expect(container.textContent).not.toContain(
    'Provider-reported packet outcomes',
  );
  expect(container.textContent).toContain('Accepted by Jito');
});

it('says outcome details are unavailable when an active signed recovery has no report', async () => {
  const { f, session, bundle, history } = await fixture();
  bundle.state = 'submitting';
  const scope = await jitoOwnerScope('alice');
  const actions: string[] = [];
  fetcher.mockImplementation(async (url, init) => {
    if (!init?.method)
      return Response.json(
        String(url).includes('bundleId=') ? exact(f, bundle) : history,
        {
          headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
        },
      );
    actions.push(JSON.parse(init.body).action);
    return Response.json(
      { bundle },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(button('Check chain outcomes').disabled).toBe(false),
  );
  await click('Check chain outcomes');
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      'Provider outcome details were unavailable',
    ),
  );
  expect(container.textContent).toContain('Submission outcome unknown');
  expect(container.textContent).not.toContain(
    'Provider-reported packet outcomes',
  );
  expect(actions).toEqual(['recover']);
});

it('clears a previously shown provider report when the signed-in owner no longer matches', async () => {
  const { f, session, bundle, history } = await fixture();
  bundle.state = 'submitted';
  bundle.bundleId = 'ab'.repeat(32);
  const scope = await jitoOwnerScope('alice');
  const otherScope = await jitoOwnerScope('bob');
  let changed = false;
  fetcher.mockImplementation(async (url, init) => {
    if (changed)
      return Response.json(
        { error: 'Signed-in account changed.' },
        {
          status: 409,
          headers: { [JITO_OWNER_SCOPE_HEADER]: otherScope },
        },
      );
    if (!init?.method)
      return Response.json(
        String(url).includes('bundleId=') ? exact(f, bundle) : history,
        {
          headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
        },
      );
    return Response.json(
      {
        bundle,
        chainObservation: {
          format: 'jito-chain-observation-v1',
          bundleId: bundle.manifest.id,
          bundleSha256: bundle.manifest.sha256,
          state: 'submitted',
          observedAt: '2026-10-28T12:00:00.000Z',
          packets: [
            {
              packet: 0,
              signature: bundle.signatures[0],
              status: 'finalized-failure',
              slot: 300,
            },
            {
              packet: 1,
              signature: bundle.signatures[1],
              status: 'not-found',
              slot: null,
            },
          ],
        },
      },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(button('Check chain outcomes').disabled).toBe(false),
  );
  await click('Check chain outcomes');
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      'Provider-reported packet outcomes',
    ),
  );
  changed = true;
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Signed-in account changed'),
  );
  expect(container.textContent).not.toContain(
    'Provider-reported packet outcomes',
  );
  expect(container.textContent).not.toContain(bundle.manifest.id);
});
it('aborts old history on session revision changes and ignores a late response', async () => {
  const { session, history } = await fixture();
  const scope = await jitoOwnerScope('alice');
  let resolve!: (r: Response) => void;
  let oldSignal!: AbortSignal;
  fetcher.mockImplementation((_url, init) => {
    oldSignal = init.signal;
    return new Promise<Response>((r) => {
      resolve = r;
    });
  });
  await render(session);
  await click('Load bundle approvals');
  await render({ ...session, revision: session.revision + 1 });
  expect(oldSignal.aborted).toBe(true);
  await act(async () =>
    resolve(
      Response.json(history, { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } }),
    ),
  );
  expect(container.textContent).not.toContain('Submit complete Jito bundle');
  expect(container.textContent).not.toContain('Explicit packet signing');
});
it('ignores an exact snapshot that arrives after the session changes', async () => {
  const { f, session, bundle, history } = await fixture();
  const scope = await jitoOwnerScope('alice');
  let resolve!: (response: Response) => void;
  let exactSignal!: AbortSignal;
  fetcher.mockImplementation((url, init) => {
    if (!String(url).includes('bundleId='))
      return Promise.resolve(
        Response.json(history, {
          headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
        }),
      );
    exactSignal = init.signal;
    return new Promise<Response>((done) => {
      resolve = done;
    });
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() => expect(exactSignal).toBeDefined());
  await render({ ...session, revision: session.revision + 1 });
  expect(exactSignal.aborted).toBe(true);
  await act(async () =>
    resolve(
      Response.json(exact(f, bundle), {
        headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
      }),
    ),
  );
  expect(container.textContent).not.toContain(bundle.manifest.id);
  expect(container.textContent).not.toContain('Submit complete Jito bundle');
});
it('rejects all late exact snapshots after StrictMode effect cleanup and re-setup', async () => {
  const { f, session, bundle, history } = await fixture();
  bundle.signatures = [null, null];
  const second = structuredClone(bundle);
  const { sha256: _old, ...terms } = second.manifest;
  terms.id = crypto.randomUUID();
  second.manifest = { ...terms, sha256: await bundleFingerprint(terms) };
  history.bundles.push(second);
  const scope = await jitoOwnerScope('alice');
  const pending: Array<{
    id: string;
    signal: AbortSignal;
    resolve: (value: Response) => void;
  }> = [];
  fetcher.mockImplementation((url, init) => {
    if (!String(url).includes('bundleId='))
      return Promise.resolve(
        Response.json(history, {
          headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
        }),
      );
    return new Promise<Response>((resolve) =>
      pending.push({
        id: new URL(String(url), 'http://localhost').searchParams.get(
          'bundleId',
        )!,
        signal: init.signal,
        resolve,
      }),
    );
  });
  const show = async (mode: 'hidden' | 'visible') =>
    act(async () =>
      root.render(
        <StrictMode>
          <Activity mode={mode}>
            <JitoAtomicBundle
              projectId={session.terms.projectId}
              session={session}
              locked={false}
            />
          </Activity>
        </StrictMode>,
      ),
    );
  await show('visible');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(button('Load bundle approvals').disabled).toBe(false);
  });
  await click('Load bundle approvals');
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  await show('hidden');
  await show('visible');
  expect(pending.some((item) => !item.signal.aborted)).toBe(true);
  await act(async () => {
    for (const item of pending)
      item.resolve(
        Response.json(
          exact(f, item.id === bundle.manifest.id ? bundle : second),
          { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
        ),
      );
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain('Bundle details need verification');
  });
  const signers = container.querySelectorAll('[data-testid="mock-signer"]');
  expect(signers.length).toBeGreaterThan(0);
  expect(
    [...signers].every((node) => node.getAttribute('data-disabled') === 'true'),
  ).toBe(true);
});
for (const kind of ['html', 'oversized', 'unauthenticated'])
  it(`shows safe recovery guidance for ${kind} responses`, async () => {
    const { session } = await fixture();
    const scope = await jitoOwnerScope('alice');
    fetcher.mockResolvedValue(
      kind === 'oversized'
        ? Response.json(
            { padding: 'x'.repeat(1048577) },
            { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
          )
        : new Response('<html>private parser stack</html>', {
            status: kind === 'unauthenticated' ? 401 : 502,
            headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
          }),
    );
    await render(session);
    await click('Load bundle approvals');
    expect(container.textContent).toContain(
      kind === 'unauthenticated'
        ? 'Sign in to recover saved bundles'
        : 'Bundle response unavailable',
    );
    expect(container.textContent).not.toContain('private parser stack');
    expect(container.textContent).not.toContain('Submit complete Jito bundle');
  });

it('blocks signing and cancellation when an exact owned snapshot reports UNKNOWN', async () => {
  const { f, session, bundle, history } = await fixture();
  bundle.signatures = [null, null];
  const scope = await jitoOwnerScope('alice');
  const attempt = {
    bundleId: bundle.manifest.id,
    manifestSha256: bundle.manifest.sha256,
    packet: 0,
    attemptId: '11111111-1111-4111-8111-111111111111',
    signer: f.review.wallet,
    intentId: f.review.id,
    state: 'unknown',
    signature: null,
    transaction: null,
  };
  fetcher.mockImplementation(async (url, init) => {
    expect(init.headers['x-jito-protocol']).toBe('2');
    expect(init.headers[JITO_OWNER_SCOPE_HEADER]).toBe(scope);
    return Response.json(
      String(url).includes('bundleId=')
        ? { ...exact(f, bundle), attempts: [attempt] }
        : history,
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(container.textContent).toContain('A signing outcome is unknown'),
  );
  expect(button('Cancel unsigned bundle').disabled).toBe(true);
  expect(button('Prepare and review selected Jito swaps').disabled).toBe(true);
  expect(
    container.querySelectorAll('[data-testid="mock-signer"]').length,
  ).toBeGreaterThan(0);
  expect(
    [...container.querySelectorAll('[data-testid="mock-signer"]')].every(
      (el) => el.getAttribute('data-disabled') === 'true',
    ),
  ).toBe(true);
});

it('keeps legacy unsigned bundles read-only, including cancellation', async () => {
  const { f, session, bundle, history } = await fixture();
  bundle.signatures = [null, null];
  const scope = await jitoOwnerScope('alice');
  fetcher.mockImplementation(async (url) =>
    Response.json(
      String(url).includes('bundleId=')
        ? { ...exact(f, bundle), legacyReadOnly: true }
        : history,
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    ),
  );
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(container.textContent).toContain('This older bundle is read-only'),
  );
  expect(button('Cancel unsigned bundle').disabled).toBe(true);
  expect(
    container.querySelectorAll('[data-testid="mock-signer"]').length,
  ).toBeGreaterThan(0);
  expect(
    [...container.querySelectorAll('[data-testid="mock-signer"]')].every(
      (el) => el.getAttribute('data-disabled') === 'true',
    ),
  ).toBe(true);
});

it('rechecks the locked local journal before cancelling a bundle', async () => {
  const { f, session, bundle, history } = await fixture();
  bundle.signatures = [null, null];
  journal.pending = [
    { bundleId: bundle.manifest.id, packet: 0, status: 'unknown' },
  ];
  const scope = await jitoOwnerScope('alice');
  let posts = 0;
  fetcher.mockImplementation(async (url, init) => {
    if (init?.method) posts++;
    return Response.json(
      String(url).includes('bundleId=') ? exact(f, bundle) : history,
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(button('Cancel unsigned bundle').disabled).toBe(false),
  );
  await click('Cancel unsigned bundle');
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      'A Jito signing outcome is still pending',
    ),
  );
  expect(posts).toBe(0);
});

it('fails closed if a registered receipt contains a different signed transaction', async () => {
  const { f, session, bundle, history } = await fixture();
  const scope = await jitoOwnerScope('alice');
  fetcher.mockImplementation(async (url) => {
    const payload = exact(f, bundle);
    payload.attempts[0].transaction = f.tip.signed.transaction;
    return Response.json(
      String(url).includes('bundleId=') ? payload : history,
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Bundle details need verification'),
  );
  expect(button('Submit complete Jito bundle').disabled).toBe(true);
});

it('records only exact preexisting evidence after expiry and never signs or submits', async () => {
  const { f, session, bundle, history } = await fixture();
  const { sha256: _old, ...terms } = bundle.manifest;
  terms.expiresAt = new Date(Date.now() - 1000).toISOString();
  bundle.manifest = { ...terms, sha256: await bundleFingerprint(terms) };
  f.manifest = bundle.manifest;
  bundle.signatures = [null, null];
  const scope = await jitoOwnerScope('alice');
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const attempt = {
    bundleId: bundle.manifest.id,
    manifestSha256: bundle.manifest.sha256,
    packet: 0,
    attemptId,
    signer: f.review.wallet,
    intentId: f.review.id,
    state: 'unknown',
    signature: null as string | null,
    transaction: null as string | null,
  };
  journal.evidence = { transaction: f.tip.signed.transaction, attemptId };
  const actions: string[] = [];
  fetcher.mockImplementation(async (url, init) => {
    if (init?.method) {
      const body = JSON.parse(init.body);
      actions.push(body.action);
      expect(body).toMatchObject({
        action: 'register',
        id: bundle.manifest.id,
        packet: 0,
        attemptId,
        approved: true,
      });
      bundle.signatures[0] = f.swap.signed.signature;
      attempt.state = 'registered';
      attempt.signature = f.swap.signed.signature;
      attempt.transaction = f.swap.signed.transaction;
      return Response.json(
        { bundle },
        { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
      );
    }
    return Response.json(
      String(url).includes('bundleId=')
        ? { ...exact(f, bundle), attempts: [attempt] }
        : history,
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(container.textContent).toContain('A signing outcome is unknown'),
  );
  await click('Register mock evidence');
  await vi.waitFor(() => expect(journal.evidenceFailed).toBe(true));
  expect(actions).toEqual([]);
  journal.evidenceFailed = false;
  journal.evidence = { transaction: f.swap.signed.transaction, attemptId };
  await click('Register mock evidence');
  await vi.waitFor(() => expect(actions).toEqual(['register']));
  await vi.waitFor(() =>
    expect(container.textContent).toContain(f.swap.signed.signature),
  );
  await vi.waitFor(() =>
    expect(container.textContent).not.toContain(
      'Another Jito action is in progress.',
    ),
  );
  await click('Register mock evidence');
  await vi.waitFor(() => expect(actions).toEqual(['register', 'register']));
  expect(actions).not.toContain('submit');
  expect(actions).not.toContain('begin-signing');
});
