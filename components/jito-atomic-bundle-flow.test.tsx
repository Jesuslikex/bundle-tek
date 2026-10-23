// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JitoAtomicBundle } from './jito-atomic-bundle';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import type { TradeSession } from '@/lib/imported-trade-session';
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
  const posts: string[] = [];
  fetcher.mockImplementation(async (_url, init) => {
    if (!init?.method) return Response.json(history);
    const action = JSON.parse(init.body).action;
    posts.push(action);
    if (action === 'submit') {
      bundle.state = 'submitting';
      throw Error('Lost reply');
    }
    return Response.json({ bundle });
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
it('aborts old history on session revision changes and ignores a late response', async () => {
  const { session, history } = await fixture();
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
  await act(async () => resolve(Response.json(history)));
  expect(container.textContent).not.toContain('Submit complete Jito bundle');
  expect(container.textContent).not.toContain('Explicit packet signing');
});
for (const kind of ['html', 'oversized', 'unauthenticated'])
  it(`shows safe recovery guidance for ${kind} responses`, async () => {
    const { session } = await fixture();
    fetcher.mockResolvedValue(
      kind === 'oversized'
        ? Response.json({ padding: 'x'.repeat(1048577) })
        : new Response('<html>private parser stack</html>', {
            status: kind === 'unauthenticated' ? 401 : 502,
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
