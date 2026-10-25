// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto, createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const controls = vi.hoisted(() => ({
  unlock: vi.fn(),
  execute: vi.fn(),
  runner: vi.fn(),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'fixture-vault',
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
import { AutoSell } from './auto-sell-modal';
import {
  profileProject,
  profileWallet,
  savedProfile,
  profileSummary,
  profileAuthority,
} from '../test/auto-sell-profile-fixture';
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', {
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    subtle: {
      digest: async (_: unknown, data: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(data).digest()).buffer,
    },
  });
  localStorage.clear();
  Object.values(controls).forEach((s) => s.mockReset());
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function click(text: string) {
  const b = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!b) throw Error('Missing ' + text);
  await act(async () => b.click());
}
it.each([false, true])(
  'restores into the real modal with a fresh empty password and zero execution (wallet changed=%s)',
  async (changed) => {
    const profile = await savedProfile();
    const fetcher = vi.fn(async (url: string) => {
      if (!url.startsWith('/api/imported-projects/auto-sell-profiles?'))
        throw Error('Unexpected network request');
      return Response.json(
        url.includes('&id=')
          ? { profile, ...profileAuthority }
          : {
              profiles: [profileSummary(profile)],
              nextCursor: null,
              ...profileAuthority,
            },
      );
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () =>
      root.render(
        <AutoSell
          project={profileProject}
          wallets={[{ ...profileWallet, revision: changed ? 2 : 1 }]}
          locked={false}
        />,
      ),
    );
    await click('Auto Sell');
    const password = host.querySelector<HTMLInputElement>(
      'input[type=password]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(password, 'not-for-storage');
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Load saved history');
    await click(`Open version 1 · ${profile.id}`);
    const label = [...host.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('I reviewed this saved configuration'),
    )!;
    await act(async () => label.querySelector('input')!.click());
    await click('Use settings for a new reviewed run');
    expect(host.textContent).toContain(
      'Configuration restored for a new reviewed run',
    );
    expect(
      host.querySelector<HTMLInputElement>('input[type=password]')!.value,
    ).toBe('');
    expect(host.textContent).toContain(
      changed ? 'Select current sell wallets' : '1 sell wallet selected',
    );
    expect(controls.unlock).not.toHaveBeenCalled();
    expect(controls.execute).not.toHaveBeenCalled();
    expect(controls.runner).not.toHaveBeenCalled();
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(
      fetcher.mock.calls.every(([url]) => url.includes('auto-sell-profiles')),
    ).toBe(true);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('not-for-storage');
    const delay = host.querySelector<HTMLInputElement>(
      'input[aria-label="Start delay hours"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(delay, '99');
      delay.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Save current settings as new profile',
    )!;
    expect(save.disabled).toBe(true);
    expect(host.textContent).toContain(
      'Complete the current settings before saving',
    );
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(controls.unlock).not.toHaveBeenCalled();
  },
);
