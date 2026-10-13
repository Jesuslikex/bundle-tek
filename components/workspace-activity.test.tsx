import React from 'react';
vi.mock('@/components/use-jito-bundle-activity', () => ({
  useJitoBundleActivity: () => ({
    events: [
      {
        id: 'a'.repeat(32),
        sequence: 1,
        type: 'bundle.submitting',
        packet: null,
        bundleId: '00000000-0000-4000-8000-000000000005',
        projectId: '00000000-0000-4000-8000-000000000001',
        sessionId: '00000000-0000-4000-8000-000000000002',
        createdAt: '2026-10-12T12:01:00Z',
        document: {
          format: 'jito-bundle-activity-v1',
          id: '00000000-0000-4000-8000-000000000005',
          projectId: '00000000-0000-4000-8000-000000000001',
          sessionId: '00000000-0000-4000-8000-000000000002',
          sessionRevision: 4,
          sha256: 'ab'.repeat(32),
          state: 'submitting',
          bundleId: null,
          swapCount: 2,
          packetCount: 3,
          signedCount: 3,
          tipLamports: '1000',
          createdAt: '2026-10-12T12:00:00Z',
          updatedAt: '2026-10-12T12:01:00Z',
        },
      },
    ],
    cursor: 'a'.repeat(32),
    loading: false,
    error: '',
    baselinePending: true,
    baseline: () => {},
    beginRefresh: () => {},
    older: () => {},
  }),
}));
vi.mock('@/components/use-session-job-activity', () => ({
  useSessionJobActivity: () => ({
    events: [
      {
        id: 'e'.repeat(32),
        sequence: 1,
        projectId: '00000000-0000-4000-8000-000000000001',
        sessionId: '00000000-0000-4000-8000-000000000002',
        jobId: '00000000-0000-4000-8000-000000000003',
        createdAt: '2026-10-11T12:00:00.000Z',
        document: {
          id: '00000000-0000-4000-8000-000000000003',
          entry: 2,
          state: 'queued',
          attempts: 1,
          preparationId: null,
          error: 'rate-limited',
        },
      },
    ],
    cursor: 'e'.repeat(32),
    loading: false,
    error: '',
  }),
}));
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect, vi, beforeAll } from 'vitest';
import { tokenWithdrawalFixture } from '../test/token-withdrawal-fixture';
import { tradeSessionTerms } from '@/lib/imported-trade-session';
import type { TradeSessionEvent } from '@/lib/imported-trade-session-events';
const sessionMock = vi.hoisted(() => ({ events: [] as TradeSessionEvent[] }));
import type { WithdrawalActivityEvent } from '@/lib/withdrawal-activity';
const withdrawalMock = vi.hoisted(() => ({
  events: [] as WithdrawalActivityEvent[],
}));
vi.mock('@/components/use-withdrawal-activity', () => ({
  useWithdrawalActivity: () => ({
    events: withdrawalMock.events,
    cursor: '1',
    loading: false,
    error: '',
  }),
}));
beforeAll(async () => {
  const f = await tokenWithdrawalFixture(false, true, true);
  const date = new Date().toISOString(),
    projectId = '00000000-0000-4000-8000-000000000001',
    sessionId = '00000000-0000-4000-8000-000000000002';
  sessionMock.events = [
    {
      id: 'a'.repeat(32),
      sequence: 1,
      projectId,
      sessionId,
      type: 'session.saved',
      approval: null,
      createdAt: date,
      document: {
        id: sessionId,
        revision: 1,
        state: 'active',
        createdAt: date,
        updatedAt: date,
        terms: tradeSessionTerms(
          {
            projectId,
            projectRevision: 7,
            side: 'Buy',
            entries: [
              {
                wallet: '11111111111111111111111111111111',
                walletRevision: 3,
                amount: '0.002',
              },
            ],
          },
          {
            chain: 'Solana',
            address: 'So11111111111111111111111111111111111111112',
            decimals: 6,
          },
        ),
      },
    },
  ];
  withdrawalMock.events = [
    {
      sequence: 1,
      createdAt: f.review.preparedAt,
      withdrawal: {
        id: f.review.id,
        wallet: f.wallet,
        walletRevision: 1,
        state: 'submitted',
        signature: f.signed.signature,
        document: f.review,
        receipt: null,
        createdAt: f.review.preparedAt,
        updatedAt: f.review.preparedAt,
      },
    },
  ];
});
vi.stubGlobal('React', React);
vi.mock('@/components/use-trade-session-activity', () => ({
  useTradeSessionActivity: () => ({
    events: sessionMock.events,
    loading: false,
    error: '',
    cursor: 'a'.repeat(32),
    beginRefresh: () => {},
  }),
}));
vi.mock('@/components/use-warmup-signing-activity', () => ({
  useWarmupSigningActivity: () => ({
    events: [
      {
        id: 'execution-qa',
        planId: 'archived-execution',
        intentId: 'approval-qa',
        preparationId: 'preparation-qa',
        planRevision: 8,
        cycle: 2,
        wallet: 'mainnet-review-wallet',
        type: 'approval.submission_started',
        state: 'submitted',
        signature: 'registered-public-signature',
        createdAt: new Date().toISOString(),
        document: {
          side: 'Sell',
          inputRaw: '1000',
          inputMint: 'owned-token',
          minimumOutputRaw: '2000',
          outputMint: 'wrapped-sol',
        },
      },
    ],
    loading: false,
    error: '',
    cursor: 'older-execution',
  }),
}));
vi.mock('@/components/use-imported-preparation-activity', () => ({
  useImportedPreparationActivity: () => ({
    events: [
      {
        id: 'saved-import-review',
        projectId: 'archived-import',
        projectRevision: 7,
        walletRevision: 3,
        createdAt: new Date().toISOString(),
        document: {
          side: 'Sell',
          wallet: 'import-review-wallet',
          simulation: { succeeded: true },
        },
      },
    ],
    loading: false,
    error: '',
    cursor: 'older-imports',
  }),
}));
vi.mock('@/components/use-warmup-preparation-activity', () => ({
  useWarmupPreparationActivity: () => ({
    events: [
      {
        id: 'saved-review',
        planId: 'archived-plan',
        planRevision: 2,
        cycle: 3,
        walletRevision: 1,
        createdAt: new Date().toISOString(),
        document: {
          side: 'Buy',
          wallet: 'review-wallet',
          simulation: { succeeded: false },
        },
      },
    ],
    loading: false,
    error: '',
    cursor: 'older',
  }),
}));
vi.mock('@/components/use-warmup-activity', () => ({
  useWarmupActivity: () => ({
    events: [
      {
        id: 'warmup-qa',
        planId: 'saved-warmup',
        type: 'plan.save',
        revision: 6,
        createdAt: new Date().toISOString(),
        summary: {
          name: 'QA warmup budget',
          chain: 'Solana',
          walletCount: 1,
          cycles: 3,
          amount: '0.002',
          totalBudget: '0.016',
        },
      },
    ],
    loading: false,
    error: '',
    cursor: null,
  }),
}));
vi.mock('@/components/use-warmup-run-activity', () => ({
  useWarmupRunActivity: () => ({
    events: [
      {
        id: 'run-qa:5',
        runId: 'run-qa',
        planId: 'saved-warmup',
        planRevision: 3,
        revision: 5,
        type: 'run.read_failed',
        state: 'completed',
        completedCount: 1,
        errorCount: 1,
        walletAddress: 'public-review-wallet',
        createdAt: new Date().toISOString(),
        name: 'Run QA warmup',
        chain: 'Solana',
        walletCount: 1,
      },
    ],
    loading: false,
    error: '',
    cursor: null,
  }),
}));
vi.mock('@/components/use-imported-activity', () => ({
  useImportedActivity: () => ({
    events: [
      {
        id: 'import-qa',
        projectId: 'saved-import',
        type: 'project.settings',
        revision: 13,
        createdAt: new Date().toISOString(),
        token: {
          name: 'USD Coin',
          symbol: 'USDC',
          chain: 'Solana',
          address: 'public-mint',
        },
      },
    ],
    loading: false,
    error: '',
    cursor: null,
  }),
}));
vi.mock('@/components/use-project-history', () => ({
  useProjectHistory: () => ({
    events: [],
    loading: false,
    error: '',
    cursor: null,
  }),
}));
vi.mock('@/components/use-wallet-audit', () => ({
  useWalletAudit: () => ({
    events: [
      {
        id: 'native-failure',
        walletAddress: 'reviewed-wallet',
        network: 'devnet',
        eventType: 'native_transfer_failed',
        transactionSignature: 'native-signature',
        createdAt: new Date().toISOString(),
        details: JSON.stringify({
          amount: '0.300000001',
          recipient: 'unpaid-native-recipient',
          fundingId: 'saved-funding',
          feeLamports: '5000',
        }),
      },
      {
        id: 'failed-spl',
        walletAddress: 'reviewed-wallet',
        network: 'devnet',
        eventType: 'token_transfer_failed',
        transactionSignature: 'existing-signature',
        createdAt: new Date().toISOString(),
        details: JSON.stringify({
          amount: '0.300000001',
          mint: 'reviewed-mint',
          recipient: 'unpaid-recipient',
          slot: 12345,
          feeLamports: '5000',
          transactionError: '{"InstructionError":[0,{"Custom":1}]}',
        }),
      },
      {
        id: 'failed-memo',
        walletAddress: 'reviewed-wallet',
        network: 'devnet',
        eventType: 'memo_failed',
        transactionSignature: 'memo-signature',
        createdAt: new Date().toISOString(),
        details: '{}',
      },
    ],
    loading: false,
    error: '',
    cursor: null,
  }),
}));
import { WorkspaceActivity } from './workspace-activity';
it('includes uncertain bundle outcomes and public progress without claiming a finalized result', () => {
  const html = renderToStaticMarkup(
    <WorkspaceActivity
      projects={[]}
      onOpen={() => {}}
      onOpenImport={() => {}}
      onOpenWarmup={() => {}}
    />,
  );
  expect(html).toContain('Jito submission reserved; outcome uncertain');
  expect(html).toContain('3/3 signatures registered');
  expect(html).toContain('tip 1000 lamports');
  expect(html).toContain('Load older Jito events');
  expect(html).toContain('Record earlier bundle baselines');
  expect(html).toContain('Each click records up to 50 bundles');
  expect(html).toContain('captured submitting');
  expect(html).not.toContain(
    'latest saved state; prior transitions not reconstructed',
  );
  expect(html).not.toContain('Jito bundle finalized');
});
it('renders failed receipts as failures with unpaid amounts and network fees', () => {
  const html = renderToStaticMarkup(
    <WorkspaceActivity
      projects={[]}
      onOpen={() => {}}
      onOpenImport={() => {}}
      onOpenWarmup={() => {}}
    />,
  );
  expect(html).toContain('Token transfer failed');
  expect(html).toContain('Devnet memo failed');
  expect(html).toContain('Native SOL funding failed');
  expect(html).toContain('0.300000001 SOL requested; not delivered');
  expect(html).toContain('0.300000001 tokens requested; not delivered');
  expect(html).toContain('network fee 5000 lamports');
  expect(html).toContain('unpaid-recipient');
  expect(html).not.toContain('Token transfer finalized');
  expect(html).not.toContain('Devnet memo finalized');
  // Only the native receipt carries a retained saved-funding reference.
  expect(html.match(/View funding history/g)).toHaveLength(1);
  expect(html).toContain('Trade settings saved · revision 13');
  expect(html).toContain('public-mint · no trade submitted');
  expect(html).toContain('Open imported project');
  expect(html).toContain('Imports');
  expect(html).toContain('QA warmup budget');
  expect(html).toContain('Configuration saved · revision 6');
  expect(html).toContain('total budget 0.016 · no swaps scheduled');
  expect(html).toContain('Open saved warmup');
  expect(html).toContain('Unsigned buy review');
  expect(html).toContain('Plan archived-plan · revision 2 · cycle 3');
  expect(html).toContain('Simulation failed · no transaction submitted');
  expect(html).toContain('View saved unsigned review');
  expect(html).toContain('Load older warmup reviews');
  expect(html).toContain('Unsigned sell review');
  expect(html).toContain('Project archived-import · revision 7');
  expect(html).toContain('Simulation completed · no transaction submitted');
  expect(html).toContain('View saved imported review');
  expect(html).toContain('Load older imported reviews');
});

it('renders public run failures distinctly from trade receipts and links the run timeline', () => {
  const html = renderToStaticMarkup(
    <WorkspaceActivity
      projects={[]}
      onOpen={() => {}}
      onOpenImport={() => {}}
      onOpenWarmup={() => {}}
    />,
  );
  expect(html).toContain('Wallet check failed');
  expect(html).toContain('plan revision 3');
  expect(html).toContain('run revision 5');
  expect(html).toContain('1/1 checked');
  expect(html).toContain('1 failed');
  expect(html).toContain('public-review-wallet');
  expect(html).toContain('View warmup run timeline');
  expect(html).toContain('public history review, no trades');
});
it('distinguishes a reserved mainnet attempt from finalized execution and links approval recovery', () => {
  const html = renderToStaticMarkup(
    <WorkspaceActivity
      projects={[]}
      onOpen={() => {}}
      onOpenImport={() => {}}
      onOpenWarmup={() => {}}
    />,
  );
  expect(html).toContain(
    'Submission attempt reserved; check finalized outcome',
  );
  expect(html).toContain('Solana mainnet');
  expect(html).toContain('Plan archived-execution · revision 8 · cycle 2');
  expect(html).toContain('mainnet-review-wallet');
  expect(html).toContain(
    'https://explorer.solana.com/tx/registered-public-signature',
  );
  expect(html).not.toContain('registered-public-signature?cluster=devnet');
  expect(html).toContain('Load older warmup execution events');
  expect(html).not.toContain('Matching finalized receipt recorded');
});
vi.mock('@/components/use-imported-signing-activity', () => ({
  useImportedSigningActivity: () => ({
    events: [
      {
        id: 'retained-import',
        sequence: 1,
        intentId: 'import-approval',
        preparationId: 'import-preparation',
        projectId: 'archived-import',
        projectRevision: 7,
        walletRevision: 3,
        wallet: 'import-reviewed-wallet',
        type: 'approval.baseline',
        state: 'cancelled',
        signature: null,
        document: {
          side: 'Buy',
          sha256: 'b'.repeat(64),
          inputRaw: '2000000',
          minimumOutputRaw: '1000',
          inputMint: 'wrapped-sol',
          outputMint: 'owned-token',
        },
        createdAt: new Date().toISOString(),
      },
    ],
    loading: false,
    error: '',
    cursor: 'older-imported-events',
  }),
}));
it('shows retained imported approval context without reconstructing execution', () => {
  const html = renderToStaticMarkup(
    <WorkspaceActivity
      projects={[]}
      onOpen={() => {}}
      onOpenImport={() => {}}
      onOpenWarmup={() => {}}
    />,
  );
  expect(html).toContain('Retained approval state');
  expect(html).toContain('Project archived-import');
  expect(html).toContain('wallet revision 3');
  expect(html).toContain('cancelled');
  expect(html).toContain('prior transitions were not reconstructed');
  expect(html).toContain('import-approval');
  expect(html).toContain('import-preparation');
  expect(html).toContain('Load older imported swap events');
});
it('includes withdrawal captured context, record access and older pages without claiming an unfinalized credit', () => {
  const html = renderToStaticMarkup(
    <WorkspaceActivity
      projects={[]}
      onOpen={() => {}}
      onOpenImport={() => {}}
      onOpenWarmup={() => {}}
      onOpenWithdrawal={() => {}}
    />,
  );
  expect(html).toContain(
    'Withdrawal submission started; check finalized outcome',
  );
  expect(html).toContain('9007199254.740993 tokens requested');
  expect(html).toContain('View withdrawal record');
  expect(html).toContain('Load older withdrawal events');
  expect(html).toContain(
    'No successful finalized transfer receipt recorded at this transition',
  );
  expect(html).not.toContain('recipient received 9007199254740893');
});

it('connects captured saved session terms to account Activity and older history controls', () => {
  const html = renderToStaticMarkup(
    <WorkspaceActivity
      projects={[]}
      onOpen={() => {}}
      onOpenImport={() => {}}
      onOpenWarmup={() => {}}
    />,
  );
  expect(html).toContain('Buy · Session saved');
  expect(html).toContain('Session 00000000-0000-4000-8000-000000000002');
  expect(html).toContain('captured active revision 1');
  expect(html).toContain('project revision 7');
  expect(html).toContain('total 2000000 atomic input units');
  expect(html).toContain('Load older trade session events');
});

it('renders captured preparation job transitions and independent pagination', () => {
  const html = renderToStaticMarkup(
    <WorkspaceActivity
      projects={[]}
      onOpen={() => {}}
      onOpenImport={() => {}}
      onOpenWarmup={() => {}}
    />,
  );
  expect(html).toContain('Unsigned preparation queued');
  expect(html).toContain('captured queued');
  expect(html).toContain('attempts 1/3');
  expect(html).toContain('rate-limited');
  expect(html).toContain('Load older preparation job events');
});
