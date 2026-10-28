// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JitoAtomicBundle } from './jito-atomic-bundle';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import type { TradeSession } from '@/lib/imported-trade-session';
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
  JitoPacketSigning: () => <p>Explicit packet signing</p>,
}));
let root: Root, container: HTMLDivElement;
const fetcher = vi.fn();
beforeEach(() => {
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
  const bundle = {
    manifest: f.manifest,
    state: 'reviewed',
    bundleId: null,
    signatures: [f.swap.signed.signature, f.tip.signed.signature],
    updatedAt: f.manifest.createdAt,
  };
  const history = {
    projectId: f.manifest.projectId,
    sessionId: session.id,
    eligible: [],
    bundles: [bundle],
  };
  return { f, session, bundle, history };
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
it('requires separate unchecked submission approval, then a lost response recovers without another send', async () => {
  const { session, bundle, history } = await fixture();
  const scope = await jitoOwnerScope('alice');
  const posts: string[] = [];
  fetcher.mockImplementation(async (_url, init) => {
    if (!init?.method)
      return Response.json(history, {
        headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
      });
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
  await act(async () => approval.click());
  await click('Submit complete Jito bundle');
  expect(posts).toEqual(['submit']);
  expect(container.textContent).not.toContain('Submit complete Jito bundle');
  await click('Check chain outcomes');
  expect(posts).toEqual(['submit', 'recover']);
  expect(container.textContent).toContain('Submission outcome unknown');
  expect(container.textContent).not.toContain('Submit complete Jito bundle');
});

it('shows only bound provider-reported packet outcomes, then clears them on history refresh', async () => {
  const { session, bundle, history } = await fixture();
  bundle.state = 'submitted';
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
  fetcher.mockImplementation(async (_url, init) => {
    if (!init?.method)
      return Response.json(history, {
        headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
      });
    posts.push(JSON.parse(init.body).action);
    return Response.json(
      { bundle, chainObservation },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Check chain outcomes'),
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
  const { session, bundle, history } = await fixture();
  bundle.state = 'submitted';
  const scope = await jitoOwnerScope('alice');
  fetcher.mockImplementation(async (_url, init) => {
    if (!init?.method)
      return Response.json(history, {
        headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
      });
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
    expect(container.textContent).toContain('Check chain outcomes'),
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
  const { session, bundle, history } = await fixture();
  bundle.state = 'submitting';
  const scope = await jitoOwnerScope('alice');
  const actions: string[] = [];
  fetcher.mockImplementation(async (_url, init) => {
    if (!init?.method)
      return Response.json(history, {
        headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
      });
    actions.push(JSON.parse(init.body).action);
    return Response.json(
      { bundle },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  await render(session);
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Check chain outcomes'),
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
  const { session, bundle, history } = await fixture();
  bundle.state = 'submitted';
  const scope = await jitoOwnerScope('alice');
  const otherScope = await jitoOwnerScope('bob');
  let changed = false;
  fetcher.mockImplementation(async (_url, init) => {
    if (changed)
      return Response.json(
        { error: 'Signed-in account changed.' },
        {
          status: 409,
          headers: { [JITO_OWNER_SCOPE_HEADER]: otherScope },
        },
      );
    if (!init?.method)
      return Response.json(history, {
        headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
      });
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
    expect(container.textContent).toContain('Check chain outcomes'),
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
