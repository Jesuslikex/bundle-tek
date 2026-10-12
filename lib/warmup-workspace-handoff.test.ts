import { expect, it } from 'vitest';
import { resolveWarmupWorkspace } from './warmup-workspace-handoff';
import type { SavedWarmup } from './wallet-warmup-storage';
import type { WalletWorkspace } from './wallet-workspace';
const plan = {
  document: {
    chain: 'Solana',
    addresses: ['a', 'b'],
    walletRevisions: [
      { address: 'a', revision: 1 },
      { address: 'b', revision: 2 },
    ],
  },
  archived: true,
} as SavedWarmup;
const workspace = (): WalletWorkspace => ({
  folders: [],
  wallets: [
    {
      chain: 'Solana',
      address: 'a',
      revision: 1,
      archived: false,
      label: 'A',
      folderId: '',
      role: 'Recipient',
      updatedAt: '',
    },
    {
      chain: 'Solana',
      address: 'b',
      revision: 2,
      archived: false,
      label: 'B',
      folderId: '',
      role: 'Funder',
      updatedAt: '',
    },
  ],
});
it('opens the whole retained wallet set in its network even for an archived plan', () => {
  expect(resolveWarmupWorkspace(plan, workspace())).toEqual({
    chain: 'Solana',
    addresses: ['a', 'b'],
    unavailable: [],
    changed: [],
    canOpen: true,
  });
});
it('reports changed revisions while retaining the exact selection', () => {
  const current = workspace();
  current.wallets[1].revision = 3;
  expect(resolveWarmupWorkspace(plan, current)).toMatchObject({
    changed: ['b'],
    unavailable: [],
    canOpen: true,
  });
});
it('withholds a partial handoff when wallets are archived, missing or on a different network', () => {
  for (const action of ['archive', 'chain', 'missing']) {
    const current = workspace();
    if (action === 'archive') current.wallets[1].archived = true;
    if (action === 'chain') current.wallets[1].chain = 'Base';
    if (action === 'missing') current.wallets.pop();
    expect(resolveWarmupWorkspace(plan, current)).toMatchObject({
      unavailable: ['b'],
      canOpen: false,
    });
  }
});
