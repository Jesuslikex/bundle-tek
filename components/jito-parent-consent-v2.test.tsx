// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JitoAtomicBundle } from './jito-atomic-bundle';
// Exercise historical consent handlers under synthetic prompt mode only.
// Default false is separately checked through the real DOM and route gate.
vi.mock('@/lib/jito-cpmm-unsigned-review', async (original) => ({
  ...(await original<typeof import('@/lib/jito-cpmm-unsigned-review')>()),
  JITO_RUNTIME_SIGNING_ENABLED: true,
}));
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import type { TradeSession } from '@/lib/imported-trade-session';
import type { JitoBundleRecord } from '@/lib/jito-bundle';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
// The underlying consent handler is exercised directly in this suite. The
// real button remains disabled and its DOM behavior is checked separately.
vi.mock('./ui/button', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}));
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
      reserve: (
        owner: string,
        manifest: JitoBundleRecord['manifest'],
        packet: number,
      ) => Promise<object>;
    };
    registerEvidence: (
      transaction: string,
      attemptId: string,
      token: object,
    ) => Promise<void>;
  }) => (
    <p data-testid="mock-signer" data-disabled={String(disabled)}>
      Explicit packet signing
      {packet === 0 && journal.reservePending && (
        <button
          onClick={() => {
            void coordinator.reserve(ownerScope, manifest, packet);
          }}
        >
          Reserve mock pending packet
        </button>
      )}
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
  reservePending: false,
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
  journal.reservePending = false;
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

function captured(element: Element, prop: 'onClick' | 'onChange') {
  const key = Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith('__reactProps$'),
  )!;
  return (
    element as unknown as Record<
      string,
      Record<string, (event: unknown) => void>
    >
  )[key][prop];
}
async function setupConsent(unsigned = false) {
  const { f, session, bundle, history } = await fixture();
  const scope = await jitoOwnerScope('alice');
  if (unsigned) bundle.signatures = [null, null];
  const posts: string[] = [];
  fetcher.mockImplementation(async (url, init) => {
    if (!init?.method)
      return Response.json(
        String(url).includes('bundleId=') ? exact(f, bundle) : history,
        { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
      );
    posts.push(JSON.parse(init.body).action);
    return Response.json(
      { bundle },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain('Bundle ' + bundle.manifest.id);
  });
  if (!unsigned) {
    const check = () =>
      [...container.querySelectorAll('label')]
        .find((l) => l.textContent?.includes('I approve submitting'))!
        .querySelector('input')!;
    await vi.waitFor(() => expect(check().disabled).toBe(false));
  } else
    await vi.waitFor(() =>
      expect(button('Cancel unsigned bundle').disabled).toBe(false),
    );
  return { f, session, bundle, posts };
}
function consentCheck() {
  return [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('I approve submitting'))!
    .querySelector('input')!;
}
async function approve() {
  await act(async () => consentCheck().click());
  await vi.waitFor(() => expect(consentCheck().checked).toBe(true));
  expect(button('Submit complete Jito bundle').disabled).toBe(true);
}
it('rejects a stale submit click after consent is unchecked and rechecked', async () => {
  const f = await setupConsent();
  await approve();
  const stale = captured(button('Submit complete Jito bundle'), 'onClick');
  await act(async () => consentCheck().click());
  await approve();
  await act(async () => stale({}));
  expect(f.posts).toEqual([]);
  // Exercise the retained consent handler separately from the disabled DOM
  // control; the real API rejects all submission while qualification is off.
  await act(async () =>
    captured(button('Submit complete Jito bundle'), 'onClick')({}),
  );
  await vi.waitFor(() => expect(f.posts).toEqual(['submit']));
});
it('rejects a stale submit click after the parent is locked', async () => {
  const f = await setupConsent();
  await approve();
  const stale = captured(button('Submit complete Jito bundle'), 'onClick');
  await act(async () =>
    root.render(
      <JitoAtomicBundle
        projectId={f.session.terms.projectId}
        session={f.session}
        locked
      />,
    ),
  );
  await act(async () => stale({}));
  expect(f.posts).toEqual([]);
});
it('rejects a stale submit click after session context changes', async () => {
  const f = await setupConsent();
  await approve();
  const stale = captured(button('Submit complete Jito bundle'), 'onClick');
  await act(async () =>
    root.render(
      <JitoAtomicBundle
        projectId={f.session.terms.projectId}
        session={{ ...f.session, id: f.session.id + '-other' }}
        locked={false}
      />,
    ),
  );
  await act(async () => stale({}));
  expect(f.posts).toEqual([]);
});
it('invalidates consent and a stale submit click after a fresh bundle snapshot', async () => {
  const f = await setupConsent();
  await approve();
  const stale = captured(button('Submit complete Jito bundle'), 'onClick');
  await click('Load bundle approvals');
  await vi.waitFor(() => expect(consentCheck().disabled).toBe(false));
  expect(consentCheck().checked).toBe(false);
  await act(async () => stale({}));
  expect(f.posts).toEqual([]);
});
it('rejects a stale cancel click after a refreshed bundle view', async () => {
  const f = await setupConsent(true);
  const stale = captured(button('Cancel unsigned bundle'), 'onClick');
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(button('Cancel unsigned bundle').disabled).toBe(false),
  );
  await act(async () => stale({}));
  expect(f.posts).toEqual([]);
});
it('rejects a stale prepare click after its entry is deselected', async () => {
  const f = await setupConsent(true);
  const label = [...container.querySelectorAll('label')].find((l) =>
    l.textContent?.includes('Session entry 1'),
  )!;
  const check = label.querySelector('input')!;
  await act(async () => check.click());
  await vi.waitFor(() =>
    expect(button('Prepare and review selected Jito swaps').disabled).toBe(
      false,
    ),
  );
  const stale = captured(
    button('Prepare and review selected Jito swaps'),
    'onClick',
  );
  await act(async () => check.click());
  await act(async () => stale({}));
  expect(f.posts).toEqual([]);
});
it('rejects a stale checkbox handler from reviving revoked submission consent', async () => {
  const f = await setupConsent();
  const stale = captured(consentCheck(), 'onChange');
  await approve();
  await act(async () => consentCheck().click());
  await act(async () => stale({ target: { checked: true } }));
  expect(consentCheck().checked).toBe(false);
  expect(button('Submit complete Jito bundle').disabled).toBe(true);
  expect(f.posts).toEqual([]);
});
it('rejects a stale create click after an approved intent is deselected', async () => {
  const { f, session, bundle, history } = await fixture();
  const scope = await jitoOwnerScope('alice');
  bundle.signatures = [null, null];
  const posts: string[] = [];
  fetcher.mockImplementation(async (url, init) => {
    if (!init?.method)
      return Response.json(
        String(url).includes('bundleId=')
          ? exact(f, bundle)
          : { ...history, eligible: [f.review] },
        { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
      );
    posts.push(JSON.parse(init.body).action);
    return Response.json(
      { bundle },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain('Entry 1:');
  });
  const label = [...container.querySelectorAll('label')].find((l) =>
    l.textContent?.includes('Entry 1:'),
  )!;
  const check = label.querySelector('input')!;
  await act(async () => check.click());
  await vi.waitFor(() =>
    expect(button('Review complete Jito bundle').disabled).toBe(false),
  );
  const stale = captured(button('Review complete Jito bundle'), 'onClick');
  await act(async () => check.click());
  await act(async () => stale({}));
  expect(posts).toEqual([]);
});
it('rejects a stale chain-outcome check after reloading the bundle, while a fresh check remains usable', async () => {
  const f = await setupConsent();
  const stale = captured(button('Check chain outcomes'), 'onClick');
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(button('Check chain outcomes').disabled).toBe(false),
  );
  await act(async () => stale({}));
  expect(f.posts).toEqual([]);
  await click('Check chain outcomes');
  await vi.waitFor(() => expect(f.posts).toEqual(['recover']));
});
it('rejects a stale verify-details click after a newer reload', async () => {
  const { f, session, bundle, history } = await fixture();
  const scope = await jitoOwnerScope('alice');
  let reads = 0;
  fetcher.mockImplementation(async (url, init) => {
    if (init?.method) throw Error('unexpected mutation');
    reads++;
    return Response.json(String(url).includes('bundleId=') ? {} : history, {
      headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
    });
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(button('Verify bundle details').disabled).toBe(false);
  });
  const stale = captured(button('Verify bundle details'), 'onClick');
  await click('Load bundle approvals');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(button('Verify bundle details').disabled).toBe(false);
  });
  const before = reads;
  await act(async () => stale({}));
  expect(reads).toBe(before);
  await click('Verify bundle details');
  await vi.waitFor(() => expect(reads).toBeGreaterThan(before));
  expect(bundle.manifest.id).toBe(f.manifest.id);
});

it('rejects stale pending-bundle metadata reads while a fresh load remains usable', async () => {
  const { f, session, bundle, history } = await fixture();
  const scope = await jitoOwnerScope('alice');
  let reads = 0;
  journal.reservePending = true;
  fetcher.mockImplementation(async (url, init) => {
    if (init?.method) throw Error('unexpected mutation');
    reads++;
    return Response.json(
      String(url).includes('bundleId=') ? exact(f, bundle) : history,
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(button('Reserve mock pending packet')).toBeTruthy(),
  );
  await click('Reserve mock pending packet');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(
      'Signer preparation is in progress',
    );
  });
  history.bundles = [];
  await click('Load bundle approvals');
  const label = 'Load original bundle ' + bundle.manifest.id;
  await vi.waitFor(() => expect(button(label).disabled).toBe(false));
  const stale = captured(button(label), 'onClick');
  await click('Load bundle approvals');
  await vi.waitFor(() => expect(button(label).disabled).toBe(false));
  const before = reads;
  await act(async () => stale({}));
  expect(reads).toBe(before);
  await click(label);
  await vi.waitFor(() => expect(reads).toBeGreaterThan(before));
});
