// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AutoSell } from './auto-sell-modal';
import {
  profileProject,
  profileWallet,
} from '../test/auto-sell-profile-fixture';
const controls = vi.hoisted(() => ({
  unlock: vi.fn(),
  execute: vi.fn(),
  runner: vi.fn(),
  identity: vi.fn(),
}));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => {
      controls.identity();
      return {
        data: { user: { id: 'synthetic-recovery-owner' } },
        isPending: false,
      };
    },
  }),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'synthetic-run-recovery-vault',
  unlockVault: controls.unlock,
}));
vi.mock('@/lib/auto-sell-execute', () => ({
  createAutoSellExecutor: controls.execute,
}));
vi.mock('@/lib/auto-sell-runner', () => ({
  AutoSellRunner: class {
    constructor() {
      controls.runner();
    }
  },
}));
vi.mock('@/lib/auto-sell-feed', () => ({
  createAutoSellFeed: () => async () => [],
}));

it('mounts metadata-only enrollment through the real modal without identity, history, vault or runner work', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.values(controls).forEach((mock) => mock.mockReset());
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toContain('auto-sell-runs?');
    expect(url).toContain('index=1');
    expect(init?.method).toBe('GET');
    return Response.json({
      projectId: profileProject.id,
      runs: [],
      nextCursor: null,
      signingAllowed: false,
      executionAllowed: false,
      automaticResumeAllowed: false,
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <AutoSell
          project={profileProject}
          wallets={[profileWallet]}
          locked={false}
        />,
      ),
    );
    const trigger = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Auto Sell',
    )!;
    await act(async () => trigger.click());
    // The modal reads the session to look for a saved run, so identity is read
    // on open; nothing is fetched until Run.
    expect(controls.identity).toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    const details = [...host.querySelectorAll('details')].find(
      (d) =>
        d.querySelector('summary')?.textContent ===
        'Record a saved run journal',
    )!;
    expect(details).toBeDefined();
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(controls.identity).toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Open a saved configuration version');
    const record = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Review saved configuration for journal',
    )!;
    expect(record.disabled).toBe(true);
    expect(
      host.querySelector<HTMLInputElement>('input[type=password]')?.value,
    ).toBe('');
    expect(controls.unlock).not.toHaveBeenCalled();
    expect(controls.execute).not.toHaveBeenCalled();
    expect(controls.runner).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
