import { DEFAULT_LAUNCH_PLAN, type LaunchPlanInput } from './launch-plan';
import { previewHolderDistribution } from './launch-distribution';
import { describe, expect, it } from 'vitest';
import {
  launchFundingRecipients,
  launchDistributionFundingRecipients,
} from './launch-funding';
import { validateFunding } from './funding-plan';
import type { WalletWorkspace } from './wallet-workspace';
import type { LaunchWalletAssignments } from './launch-wallets';
const deployer = '11111111111111111111111111111111',
  recipient = 'So11111111111111111111111111111111111111112';
const workspace: WalletWorkspace = {
  folders: [
    {
      id: 'f',
      chain: 'Solana',
      name: 'Launch',
      archived: false,
      revision: 2,
      updatedAt: '',
    },
  ],
  wallets: [
    {
      chain: 'Solana',
      address: deployer,
      label: '',
      role: 'Deployer',
      folderId: 'f',
      archived: false,
      revision: 3,
      updatedAt: '',
    },
    {
      chain: 'Solana',
      address: recipient,
      label: '',
      role: 'Recipient',
      folderId: 'f',
      archived: false,
      revision: 4,
      updatedAt: '',
    },
  ],
};
const selected: LaunchWalletAssignments = {
  chain: 'Solana',
  deployer: { address: deployer, revision: 3, folderRevision: 2 },
  recipients: [{ address: recipient, revision: 4, folderRevision: 2 }],
};
describe('launch selection funding handoff', () => {
  it('validates the selected secondary membership without duplicating its funding recipient', () => {
    const roster = structuredClone(workspace);
    roster.folders.push({ ...roster.folders[0], id: 'b', revision: 5 });
    roster.wallets[1].folderIds = ['f', 'b'];
    roster.folders[0].archived = true;
    const choice = {
      chain: 'Solana' as const,
      recipients: [
        { address: recipient, revision: 4, folderRevision: 5, folderId: 'b' },
      ],
    };
    expect(
      launchFundingRecipients(choice, roster, 'Solana', '0.01', false, '0'),
    ).toEqual([{ address: recipient, amount: '0.01' }]);
    roster.wallets[1].folderIds = ['f'];
    expect(() =>
      launchFundingRecipients(choice, roster, 'Solana', '0.01', false, '0'),
    ).toThrow('changed');
  });
  it('copies only selected recipients by default and optionally admits a separate deployer amount', () => {
    expect(
      launchFundingRecipients(
        selected,
        workspace,
        'Solana',
        '0.020000001',
        false,
        '0.05',
      ),
    ).toEqual([{ address: recipient, amount: '0.020000001' }]);
    const recipients = launchFundingRecipients(
      selected,
      workspace,
      'Solana',
      '0.020000001',
      true,
      '0.05',
    );
    const funding = validateFunding({
      name: 'Launch allocations',
      chain: 'Solana',
      currency: 'SOL',
      source: 'Manual',
      sourceLabel: '',
      funderAddress: '',
      startAt: '2026-10-09T00:00:00.000Z',
      delaySeconds: 10,
      recipients,
    });
    expect(funding.total).toBe('0.070000001');
    expect(funding.recipients[0]).toEqual({
      address: deployer,
      amount: '0.05',
    });
  });
  it('rejects missing or wrong-network selection and changed role/revisions without a partial list', () => {
    expect(() =>
      launchFundingRecipients(undefined, workspace, 'Solana', '1', false, '1'),
    ).toThrow('first');
    expect(() =>
      launchFundingRecipients(selected, workspace, 'Base', '1', false, '1'),
    ).toThrow('network');
    for (const update of [
      { revision: 5 },
      { role: 'Funder' as const },
      { archived: true },
    ]) {
      const changed = structuredClone(workspace);
      Object.assign(changed.wallets[1], update);
      expect(() =>
        launchFundingRecipients(selected, changed, 'Solana', '1', true, '1'),
      ).toThrow('changed');
    }
    const archived = structuredClone(workspace);
    archived.folders[0].archived = true;
    expect(() =>
      launchFundingRecipients(selected, archived, 'Solana', '1', false, '1'),
    ).toThrow('archived');
  });
  it('rejects funding cap overflow and unavailable deployer rather than dropping addresses', () => {
    expect(() =>
      launchFundingRecipients(
        {
          ...selected,
          recipients: Array.from({ length: 100 }, () => selected.recipients[0]),
        },
        workspace,
        'Solana',
        '1',
        true,
        '1',
      ),
    ).toThrow('100');
    expect(() =>
      launchFundingRecipients(
        { ...selected, deployer: undefined },
        workspace,
        'Solana',
        '1',
        true,
        '1',
      ),
    ).toThrow('deployer');
  });
});

describe('holder distribution funding handoff', () => {
  const third = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const roster = structuredClone(workspace);
  roster.wallets.push({ ...roster.wallets[1], address: third });
  const selection = {
    ...selected,
    recipients: [
      ...selected.recipients,
      { ...selected.recipients[0], address: third },
    ],
  };
  const plan: LaunchPlanInput = {
    ...DEFAULT_LAUNCH_PLAN,
    mode: 'Stagger' as const,
    holderCount: 2,
    holdersBuyQuote: '0.020000001',
    holdersDistribution: {
      kind: 'random' as const,
      deviationPercent: 150,
      seed: '1234567890abcdef1234567890abcdef',
    },
  };
  const copy = (
    input = plan,
    refs = selection,
    current = roster,
    include = false,
  ) =>
    launchDistributionFundingRecipients(
      input,
      refs,
      current,
      'Solana',
      'SOL',
      include,
      '0.05',
    );
  it('preserves ordered exact weighted amounts with a separate optional deployer amount', () => {
    const rows = copy();
    expect(rows.map((r) => r.address)).toEqual([recipient, third]);
    expect(rows.map((r) => r.amount)).toEqual(
      previewHolderDistribution(plan)!.items.map((r) => r.amount),
    );
    expect(rows[0].amount).not.toBe(rows[1].amount);
    const document = validateFunding({
      name: 'Weighted',
      chain: 'Solana',
      currency: 'SOL',
      source: 'Manual',
      sourceLabel: '',
      funderAddress: '',
      startAt: new Date().toISOString(),
      delaySeconds: 10,
      recipients: copy(plan, selection, roster, true),
    });
    expect(document.total).toBe('0.070000001');
    expect(document.recipients[0]).toEqual({
      address: deployer,
      amount: '0.05',
    });
    const reversed = {
      ...selection,
      recipients: [...selection.recipients].reverse(),
    };
    expect(copy(plan, reversed).map((r) => r.amount)).toEqual(
      rows.map((r) => r.amount),
    );
    expect(copy(plan, reversed).map((r) => r.address)).toEqual([
      third,
      recipient,
    ]);
  });
  it('rejects supply, missing slots, zeros, stale roster and different funding denomination', () => {
    expect(() => copy({ ...plan, mode: 'Block-0' })).toThrow('Supply');
    expect(() =>
      copy(plan, { ...selection, recipients: [selection.recipients[0]] }),
    ).toThrow('every holder');
    expect(() =>
      copy({
        ...plan,
        holdersDistribution: { ...plan.holdersDistribution!, kind: 'single' },
      }),
    ).toThrow('zero');
    const stale = structuredClone(roster);
    stale.wallets[2].revision++;
    expect(() => copy(plan, selection, stale)).toThrow('changed');
    expect(() =>
      launchDistributionFundingRecipients(
        plan,
        selection,
        roster,
        'Solana',
        'USDC',
        false,
        '1',
      ),
    ).toThrow('match');
    expect(() => copy({ ...plan, holdersDistribution: undefined })).toThrow(
      'Configure',
    );
    const token = {
      ...plan,
      currency: 'USDC',
      quoteAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    };
    expect(() =>
      launchDistributionFundingRecipients(
        token,
        selection,
        roster,
        'Solana',
        'USDC',
        false,
        '1',
      ),
    ).toThrow('native');
    const fundedToken = { ...token, holdersBuyQuote: '0.020001' };
    const rows = launchDistributionFundingRecipients(
      fundedToken,
      selection,
      roster,
      'Solana',
      'USDC',
      false,
      '1',
      token.quoteAddress,
    );
    expect(
      validateFunding({
        name: 'Token weights',
        chain: 'Solana',
        currency: 'USDC',
        assetAddress: token.quoteAddress,
        source: 'Manual',
        sourceLabel: '',
        funderAddress: '',
        startAt: new Date().toISOString(),
        delaySeconds: 0,
        recipients: rows,
      }).total,
    ).toBe('0.020001');
    expect(() =>
      launchDistributionFundingRecipients(
        fundedToken,
        selection,
        roster,
        'Solana',
        'USDC',
        false,
        '1',
        'wrong',
      ),
    ).toThrow('address');
  });
});

it('copies unassigned launch recipients and rejects a changed membership', () => {
  const roster = structuredClone(workspace);
  roster.wallets[1].folderId = '';
  roster.wallets[1].folderIds = [];
  const choice: LaunchWalletAssignments = {
    chain: 'Solana',
    recipients: [{ address: recipient, revision: 4, folderRevision: 0 }],
  };
  expect(
    launchFundingRecipients(choice, roster, 'Solana', '0.01', false, '0'),
  ).toEqual([{ address: recipient, amount: '0.01' }]);
  roster.wallets[1].folderIds = ['f'];
  expect(() =>
    launchFundingRecipients(choice, roster, 'Solana', '0.01', false, '0'),
  ).toThrow('changed');
});

it('copies a parent-wallet reference through archived folders while rejecting archived wallets', () => {
  const roster = structuredClone(workspace);
  roster.folders[0].archived = true;
  const choice: LaunchWalletAssignments = {
    chain: 'Solana',
    recipients: [
      { address: recipient, revision: 4, folderRevision: 0, root: true },
    ],
  };
  expect(
    launchFundingRecipients(choice, roster, 'Solana', '0.01', false, '0'),
  ).toEqual([{ address: recipient, amount: '0.01' }]);
  roster.wallets[1].archived = true;
  expect(() =>
    launchFundingRecipients(choice, roster, 'Solana', '0.01', false, '0'),
  ).toThrow('changed');
});
