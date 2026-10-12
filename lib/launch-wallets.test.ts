import { describe, expect, it } from 'vitest';
import {
  activeLaunchWallets,
  parseLaunchWalletAssignments,
  referenceForWallet,
  validateLaunchWalletSelection,
} from './launch-wallets';
import type { WalletWorkspace } from './wallet-workspace';
const address = '11111111111111111111111111111111';
describe('launch wallet references', () => {
  it('keeps legacy absence and admits canonical public-address references', () => {
    expect(parseLaunchWalletAssignments(undefined)).toBeUndefined();
    expect(
      parseLaunchWalletAssignments({
        chain: 'Solana',
        recipients: [{ address, revision: 1, folderRevision: 2 }],
      }),
    ).toEqual({
      chain: 'Solana',
      recipients: [{ address, revision: 1, folderRevision: 2 }],
    });
    expect(() =>
      parseLaunchWalletAssignments({
        chain: 'Solana',
        deployer: { address, revision: 1, folderRevision: 1 },
        recipients: [{ address, revision: 1, folderRevision: 1 }],
      }),
    ).toThrow('unique');
    for (const revision of [0, 1.5, '1', Number.MAX_SAFE_INTEGER])
      expect(() =>
        parseLaunchWalletAssignments({
          chain: 'Solana',
          recipients: [{ address, revision, folderRevision: 1 }],
        }),
      ).toThrow('revision');
    expect(() =>
      parseLaunchWalletAssignments({
        chain: 'Solana',
        recipients: [{ address: 'bad', revision: 1, folderRevision: 1 }],
      }),
    ).toThrow('valid');
  });
  it('checks network and recipient counts separately from historical document parsing', () => {
    const selected = parseLaunchWalletAssignments({
      chain: 'Solana',
      recipients: [{ address, revision: 1, folderRevision: 1 }],
    });
    expect(() => validateLaunchWalletSelection(selected, 'Base', 10)).toThrow(
      'network',
    );
    expect(() => validateLaunchWalletSelection(selected, 'Solana', 0)).toThrow(
      'holder count',
    );
    expect(() =>
      validateLaunchWalletSelection(selected, 'Solana', 10),
    ).not.toThrow();
  });
  it('keeps parent wallets accessible while explicit folder references require an active folder', () => {
    const workspace: WalletWorkspace = {
      folders: [
        {
          id: 'f',
          chain: 'Solana',
          name: 'Test',
          archived: false,
          revision: 7,
          updatedAt: '',
        },
      ],
      wallets: [
        {
          chain: 'Solana',
          address,
          folderId: 'f',
          label: '',
          role: 'Recipient',
          archived: false,
          revision: 3,
          updatedAt: '',
        },
      ],
    };
    expect(referenceForWallet(workspace.wallets[0], workspace, 'f')).toEqual({
      address,
      revision: 3,
      folderRevision: 7,
      folderId: 'f',
    });
    expect(activeLaunchWallets(workspace, 'Solana')).toHaveLength(1);
    workspace.folders[0].archived = true;
    expect(activeLaunchWallets(workspace, 'Solana')).toHaveLength(1);
    expect(referenceForWallet(workspace.wallets[0], workspace)).toEqual({
      address,
      revision: 3,
      folderRevision: 0,
      root: true,
    });
    expect(() =>
      referenceForWallet(workspace.wallets[0], workspace, 'f'),
    ).toThrow('Restore');
  });
});

it('admits unassigned active wallets with an explicit zero folder revision', () => {
  const workspace: WalletWorkspace = {
    folders: [],
    wallets: [
      {
        chain: 'Solana',
        address,
        folderId: '',
        folderIds: [],
        label: '',
        role: 'Recipient',
        archived: false,
        revision: 1,
        updatedAt: 'now',
      },
    ],
  };
  expect(activeLaunchWallets(workspace, 'Solana')).toHaveLength(1);
  const ref = referenceForWallet(workspace.wallets[0], workspace);
  expect(ref).toEqual({ address, revision: 1, folderRevision: 0, root: true });
  expect(
    parseLaunchWalletAssignments({ chain: 'Solana', recipients: [ref] })
      ?.recipients,
  ).toEqual([ref]);
  expect(() =>
    parseLaunchWalletAssignments({
      chain: 'Solana',
      recipients: [{ ...ref, folderId: 'a' }],
    }),
  ).toThrow();
});
