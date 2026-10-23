// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoSell } from './auto-sell-modal';
import { installAutoSellBrowserLocks } from '../test/auto-sell-browser-lock-fixture';
import { AutoSellRunner } from '@/lib/auto-sell-runner';
import { unlockVault, type VaultSession } from '@/lib/browser-wallet-vault';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import type { AutoSellObservedTrade } from '@/lib/auto-sell';
import {
  autoSellOutcomePage,
  autoSellOutcomeReference as outcomeRef,
} from '../test/auto-sell-outcome-fixture';
const feed = vi.hoisted(() => ({
  read: vi.fn(async () => [] as AutoSellObservedTrade[]),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'synthetic-auto-sell-vault',
  unlockVault: vi.fn(),
}));
vi.mock('@/lib/auto-sell-feed', () => ({
  createAutoSellFeed: () => feed.read,
}));
const address = '11111111111111111111111111111111';
const project = {
  id: 'synthetic-project',
  revision: 1,
  archived: false,
  document: {
    token: {
      chain: 'Solana',
      address: 'So11111111111111111111111111111111111111112',
      decimals: 6,
      totalSupplyRaw: '1000000000',
    },
  },
} as ImportedTokenProject;
const wallets = [
  {
    address,
    chain: 'Solana',
    revision: 1,
    archived: false,
    label: 'Synthetic sell wallet',
  },
] as WorkspaceWallet[];
let host: HTMLDivElement, root: Root | null;
let restoreLocks: () => void;
beforeEach(() => {
  restoreLocks = installAutoSellBrowserLocks();
  vi.mocked(unlockVault).mockReset();
  feed.read.mockReset().mockResolvedValue([]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.setItem('synthetic-auto-sell-vault', 'FIXTURE ONLY');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  restoreLocks();
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(['stale', 'failed'] as const)(
  'clears the ranged preview after a %s feed read without unlocking',
  async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    feed.read.mockResolvedValue([
      {
        id: 'fixture',
        sender: 'OUTSIDE',
        side: 'Sell',
        tokenAmount: '1',
        quoteAmount: '1',
        priceUsd: '1',
        timestamp: new Date(Date.now()).toISOString(),
      },
    ]);
    await act(async () =>
      root!.render(
        <AutoSell project={project} wallets={wallets} locked={false} />,
      ),
    );
    await click('Auto Sell');
    await click('Market Cap Range0->∞');
    await editSession('input[id$="-mcmin"]', '1');
    expect(host.textContent).not.toContain('Out-of-Range');
    if (kind === 'failed')
      feed.read.mockRejectedValueOnce(Error('synthetic provider failure'));
    await act(async () =>
      vi.advanceTimersByTimeAsync(kind === 'stale' ? 75000 : 15000),
    );
    expect(host.textContent).toContain('Out-of-Range');
    expect(unlockVault).not.toHaveBeenCalled();
  },
);
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function startUnlock(configure?: () => Promise<void>) {
  await act(async () =>
    root!.render(
      <AutoSell project={project} wallets={wallets} locked={false} />,
    ),
  );
  await click('Auto Sell');
  const replication = [...host.querySelectorAll('label')].find((x) =>
    x.textContent?.includes('Replication Factor'),
  )!;
  const replicationInput = document.getElementById(
    replication.htmlFor,
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(replicationInput, '10');
    replicationInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const label = [...host.querySelectorAll('label')].find((x) =>
    x.textContent?.includes('Synthetic sell wallet'),
  )!;
  await act(async () =>
    label.querySelector<HTMLInputElement>('input')!.click(),
  );
  const password = host.querySelector<HTMLInputElement>(
    'input[type="password"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(password, 'SYNTHETIC PASSWORD');
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await configure?.();
  await click('Run 1 Strategy');
}
it('never starts a run when vault unlock completes after the component unmounts', async () => {
  let resolve!: (value: VaultSession) => void;
  vi.mocked(unlockVault).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const start = vi
    .spyOn(AutoSellRunner.prototype, 'start')
    .mockImplementation(() => {});
  await startUnlock();
  expect(unlockVault).toHaveBeenCalledTimes(1);
  await act(async () => root!.unmount());
  root = null;
  const session = {
    payload: { wallets: [{ family: 'solana', address }] },
  } as VaultSession;
  await act(async () => resolve(session));
  expect(start).not.toHaveBeenCalled();
  expect(session.payload.wallets).toEqual([]);
});

it.each([
  'pagehide',
  'cancel',
  'close',
  'escape',
  'project',
  'wallet',
  'locked',
] as const)(
  'discards a pending unlock after %s invalidates the review',
  async (change) => {
    let resolve!: (value: VaultSession) => void;
    vi.mocked(unlockVault).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const start = vi
      .spyOn(AutoSellRunner.prototype, 'start')
      .mockImplementation(() => {});
    await startUnlock();
    expect(unlockVault).toHaveBeenCalledTimes(1);
    if (change === 'pagehide') {
      await act(async () => window.dispatchEvent(new Event('pagehide')));
    } else if (change === 'cancel') {
      await click('Cancel unlock');
    } else if (change === 'close') {
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
          .click(),
      );
    } else if (change === 'escape') {
      await act(async () => {
        host
          .querySelector('dialog')!
          .dispatchEvent(new Event('cancel', { cancelable: true }));
      });
    } else {
      await act(async () =>
        root!.render(
          <AutoSell
            project={
              change === 'project' ? { ...project, revision: 2 } : project
            }
            wallets={
              change === 'wallet'
                ? wallets.map((w) => ({ ...w, revision: 2 }))
                : wallets
            }
            locked={change === 'locked'}
          />,
        ),
      );
    }
    const session = {
      payload: { wallets: [{ family: 'solana', address }] },
    } as VaultSession;
    await act(async () => resolve(session));
    expect(start).not.toHaveBeenCalled();
    expect(session.payload.wallets).toEqual([]);
  },
);

it('starts only the currently approved run and erases the session on Stop', async () => {
  const session = {
    payload: { wallets: [{ family: 'solana', address }] },
  } as VaultSession;
  vi.mocked(unlockVault).mockResolvedValueOnce(session);
  const start = vi.spyOn(AutoSellRunner.prototype, 'start');
  await startUnlock();
  expect(start).toHaveBeenCalledOnce();
  await click('Stop');
  expect(host.textContent).toContain('Stopped by you.');
  expect(session.payload.wallets).toEqual([]);
});

async function editSession(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it.each([false, true])(
  'allows saved-history inspection while locked (archived=%s) without vault unlock or runner start',
  async (archived) => {
    const fetcher = vi.fn(async () => Response.json(autoSellOutcomePage()));
    vi.stubGlobal('fetch', fetcher);
    const start = vi.spyOn(AutoSellRunner.prototype, 'start');
    await act(async () =>
      root!.render(
        <AutoSell
          project={{
            ...project,
            id: outcomeRef.projectId,
            archived,
            document: {
              ...project.document,
              token: { ...project.document.token, address: outcomeRef.mint },
            },
          }}
          wallets={wallets}
          locked={true}
        />,
      ),
    );
    await click('Auto Sell');
    await editSession('input[id$="-rep"]', '50');
    await editSession('input[type="password"]', 'SYNTHETIC ONLY');
    await act(async () =>
      host
        .querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!
        .click(),
    );
    const run = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Run 1 Strategy',
    )!;
    expect(run.disabled).toBe(true);
    await act(async () => run.click());
    const summary = [...host.querySelectorAll('summary')].find(
      (s) => s.textContent === 'Find saved Sell approvals',
    )!;
    await act(async () => summary.click());
    expect(fetcher).not.toHaveBeenCalled();
    expect(feed.read).not.toHaveBeenCalled();
    await click('Read latest saved approvals');
    await vi.waitFor(() =>
      expect(host.textContent).toContain(
        'Submission recorded; receipt proof not loaded',
      ),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(unlockVault).not.toHaveBeenCalled();
    expect(feed.read).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(run.disabled).toBe(true);
  },
);

it.each(['locked', 'wallet'] as const)(
  'announces an inner %s context reset and focuses the replacement trigger without retaining a stale read',
  async (change) => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const valid = {
      ...project,
      id: outcomeRef.projectId,
      document: {
        ...project.document,
        token: { ...project.document.token, address: outcomeRef.mint },
      },
    };
    await act(async () =>
      root!.render(
        <AutoSell project={valid} wallets={wallets} locked={true} />,
      ),
    );
    await click('Auto Sell');
    const summary = [...host.querySelectorAll('summary')].find(
      (s) => s.textContent === 'Find saved Sell approvals',
    )!;
    await act(async () => summary.click());
    await click('Read latest saved approvals');
    const signal = fetcher.mock.calls[0][1]!.signal!;
    await act(async () =>
      root!.render(
        <AutoSell
          project={valid}
          wallets={
            change === 'wallet'
              ? wallets.map((w) => ({ ...w, revision: 2 }))
              : wallets
          }
          locked={change === 'locked' ? false : true}
        />,
      ),
    );
    expect(signal.aborted).toBe(true);
    expect(host.querySelector('dialog')).toBeNull();
    const trigger = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Auto Sell',
    )!;
    expect(document.activeElement).toBe(trigger);
    expect(
      host.querySelector('output[aria-label="Auto Sell view change"]')!
        .textContent,
    ).toContain('Workspace context changed');
    await act(async () => finish(Response.json(autoSellOutcomePage())));
    expect(host.textContent).not.toContain(outcomeRef.intentId);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(unlockVault).not.toHaveBeenCalled();
    await click('Auto Sell');
    expect(
      host.querySelector('output[aria-label="Auto Sell view change"]')!
        .textContent,
    ).toBe('');
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

it('binds the selected session delay to the running strategy clock', async () => {
  const session = {
    payload: { wallets: [{ family: 'solana', address }] },
  } as VaultSession;
  vi.mocked(unlockVault).mockResolvedValueOnce(session);
  const start = vi.spyOn(AutoSellRunner.prototype, 'start');
  const before = Date.now();
  await startUnlock(async () => {
    await editSession('[aria-label="Start delay seconds"]', '15');
    await editSession('[aria-label="Session duration seconds"]', '30');
    await editSession('input[placeholder="No shared limit"]', '5');
  });
  expect(start).toHaveBeenCalledOnce();
  const instance = start.mock.instances[0] as AutoSellRunner;
  const states = Object.values(instance.snapshot().states);
  expect(states).toHaveLength(1);
  expect(states[0].startedAt).toBeGreaterThanOrEqual(before + 15000);
  expect(states[0].startedAt).toBeLessThanOrEqual(Date.now() + 15000);
  await click('Stop');
  expect(session.payload.wallets).toEqual([]);
});

it('refuses an invalid shared cap before attempting vault unlock', async () => {
  await startUnlock(async () =>
    editSession('input[placeholder="No shared limit"]', '0'),
  );
  expect(unlockVault).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'greater than 0',
  );
});

it('pauses and resumes the same approved browser session without another unlock', async () => {
  const session = {
    payload: { wallets: [{ family: 'solana', address }] },
  } as VaultSession;
  vi.mocked(unlockVault).mockResolvedValueOnce(session);
  await startUnlock();
  await click('Pause');
  expect(host.textContent).toContain('Auto Sell · paused');
  expect(
    host.querySelector('output[aria-label="Auto Sell session status"]')
      ?.textContent,
  ).toContain('Session time limits continue while paused');
  expect(session.payload.wallets).toHaveLength(1);
  await click('Resume');
  expect(host.textContent).toContain('Auto Sell · running');
  expect(unlockVault).toHaveBeenCalledTimes(1);
  await click('Pause');
  await click('Stop');
  expect(session.payload.wallets).toEqual([]);
  expect(
    [...host.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Resume',
    ),
  ).toBe(false);
});

it('invalidates a paused session when its owned wallet context changes', async () => {
  const session = {
    payload: { wallets: [{ family: 'solana', address }] },
  } as VaultSession;
  vi.mocked(unlockVault).mockResolvedValueOnce(session);
  await startUnlock();
  await click('Pause');
  await act(async () =>
    root!.render(
      <AutoSell
        project={project}
        wallets={wallets.map((wallet) => ({ ...wallet, revision: 2 }))}
        locked={false}
      />,
    ),
  );
  expect(session.payload.wallets).toEqual([]);
  expect(host.querySelector('dialog')).toBeNull();
  expect(host.textContent).not.toContain('Auto Sell · paused');
});

async function startEditable() {
  vi.mocked(unlockVault).mockResolvedValueOnce({
    payload: { wallets: [{ family: 'solana', address }] },
  } as VaultSession);
  const start = vi.spyOn(AutoSellRunner.prototype, 'start');
  await startUnlock();
  await click('Pause');
  await click('Edit');
  return start.mock.instances[0] as AutoSellRunner;
}
function replicationSelector() {
  const label = [...host.querySelectorAll('label')].find((item) =>
    item.textContent?.includes('Replication Factor'),
  )!;
  return `input[id="${label.htmlFor}"]`;
}
it('requires exact unchecked edit approval and stays paused without another unlock', async () => {
  const instance = await startEditable();
  await editSession(replicationSelector(), '20');
  await click('Review changes');
  const approval = host.querySelector<HTMLInputElement>(
    '[data-edit-approval] input',
  )!;
  expect(approval.checked).toBe(false);
  await click('Apply approved changes');
  expect(instance.configuration().strategies[0].replicationPercent).toBe('10');
  await act(async () => approval.click());
  await click('Apply approved changes');
  expect(instance.configuration().strategies[0].replicationPercent).toBe('20');
  expect(instance.snapshot().paused).toBe(true);
  expect(instance.snapshot().configurationRevision).toBe(2);
  expect(unlockVault).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('I approve these exact');
  await click('Stop');
});
it('invalidates approval on every draft edit including changing back to the reviewed value', async () => {
  const instance = await startEditable();
  await editSession(replicationSelector(), '20');
  await click('Review changes');
  await act(async () =>
    host.querySelector<HTMLInputElement>('[data-edit-approval] input')!.click(),
  );
  await editSession(replicationSelector(), '21');
  await editSession(replicationSelector(), '20');
  expect(host.querySelector('[data-edit-approval]')).toBeNull();
  expect(instance.configuration().strategies[0].replicationPercent).toBe('10');
  await click('Review changes');
  expect(
    host.querySelector<HTMLInputElement>('[data-edit-approval] input')!.checked,
  ).toBe(false);
  await act(async () =>
    host.querySelector<HTMLInputElement>('[data-edit-approval] input')!.click(),
  );
  await click('◷ DCA');
  await click('↺ Counter Trading');
  expect(host.querySelector('[data-edit-approval]')).toBeNull();
  expect(instance.configuration().strategies[0].replicationPercent).toBe('10');
  await click('Stop');
});
it.each(['Cancel edits', 'Close'])(
  'discards unapplied edits on %s and preserves the original paused configuration',
  async (action) => {
    const instance = await startEditable();
    expect(
      host.querySelector<HTMLInputElement>(
        '[aria-label="Start delay seconds"]',
      )!.disabled,
    ).toBe(true);
    await editSession(replicationSelector(), '20');
    await editSession('[aria-label="Session duration seconds"]', '45');
    await click('Review changes');
    await click(action);
    if (action === 'Close') await click('Auto Sell · paused');
    expect(
      host.querySelector<HTMLInputElement>(replicationSelector())!.value,
    ).toBe('10');
    expect(
      host.querySelector<HTMLInputElement>(
        '[aria-label="Session duration seconds"]',
      )!.value,
    ).toBe('0');
    expect(instance.configuration().strategies[0].replicationPercent).toBe(
      '10',
    );
    expect(instance.snapshot().paused).toBe(true);
    await click('Resume');
    expect(instance.snapshot().paused).toBe(false);
    expect(unlockVault).toHaveBeenCalledTimes(1);
    await click('Stop');
  },
);

it('shows the strategies and whole session an approved minimum-cap edit will end', async () => {
  const instance = await startEditable();
  const minimumLabel = [
    ...host.querySelectorAll<HTMLLabelElement>('label'),
  ].find((label) => label.textContent?.includes('Min. % Supply per Sell'))!;
  await editSession(`input[id="${minimumLabel.htmlFor}"]`, '0.5');
  await editSession('input[id$="-session-max"]', '0.4');
  await click('Review changes');
  expect(
    host.querySelector('ul[aria-label="Strategies that will end"]')
      ?.textContent,
  ).toContain('minimum sell');
  expect(host.textContent).toContain(
    'Applying these changes will end this session.',
  );
  const approval = host.querySelector<HTMLInputElement>(
    '[data-edit-approval] input',
  )!;
  expect(approval.checked).toBe(false);
  await click('Apply approved changes');
  expect(instance.isRunning()).toBe(true);
  await act(async () => approval.click());
  await click('Apply approved changes');
  expect(instance.isRunning()).toBe(false);
  expect(unlockVault).toHaveBeenCalledTimes(1);
});

it('reviews token caps explicitly, clears values when units switch and restores canceled edits', async () => {
  const instance = await startEditable();
  const chooseUnit = async (group: string, name: string) => {
    const scope = host.querySelector(`[aria-label="${group}"]`)!;
    const button = [...scope.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === name,
    )!;
    await act(async () => button.click());
  };
  await editSession('input[id$="-session-max"]', '2');
  await chooseUnit('Session maximum unit', 'Token amount');
  expect(
    host.querySelector<HTMLInputElement>('input[id$="-session-max"]')!.value,
  ).toBe('');
  await editSession('input[id$="-session-max"]', '12.5');
  await click('End Conditions—');
  await chooseUnit('Strategy maximum unit', 'Token amount');
  await editSession('input[id$="-max"]:not([id$="-session-max"])', '10.25');
  await click('Review changes');
  expect(host.textContent).toContain('After: 12.5 tokens');
  expect(host.textContent).toContain('After: 10.25 tokens');
  const approval = host.querySelector<HTMLInputElement>(
    '[data-edit-approval] input',
  )!;
  expect(approval.checked).toBe(false);
  await act(async () => approval.click());
  await chooseUnit('Session maximum unit', '% Supply');
  expect(host.querySelector('[data-edit-approval] input')).toBeNull();
  expect(
    host.querySelector<HTMLInputElement>('input[id$="-session-max"]')!.value,
  ).toBe('');
  await click('Cancel edits');
  expect(instance.configuration().session.endMaxTokenAmount).toBeUndefined();
  expect(
    instance.configuration().strategies[0].endMaxTokenAmount,
  ).toBeUndefined();
  expect(instance.snapshot().paused).toBe(true);
  expect(unlockVault).toHaveBeenCalledTimes(1);
  await click('Stop');
});

it('never restores approved consent by switching a blank session maximum unit away and back', async () => {
  const instance = await startEditable();
  await editSession(replicationSelector(), '20');
  await click('Review changes');
  await act(async () =>
    host.querySelector<HTMLInputElement>('[data-edit-approval] input')!.click(),
  );
  const choose = async (name: string) => {
    const group = host.querySelector('[aria-label="Session maximum unit"]')!;
    await act(async () =>
      [...group.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === name)!
        .click(),
    );
  };
  await choose('Token amount');
  await choose('% Supply');
  expect(host.querySelector('[data-edit-approval] input')).toBeNull();
  expect(
    [...host.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Apply approved changes',
    ),
  ).toBe(false);
  expect(instance.configuration().strategies[0].replicationPercent).toBe('10');
  expect(instance.snapshot().paused).toBe(true);
  await click('Review changes');
  expect(
    host.querySelector<HTMLInputElement>('[data-edit-approval] input')!.checked,
  ).toBe(false);
  await click('Stop');
});
