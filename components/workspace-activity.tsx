'use client';
import { useSessionJobActivity } from './use-session-job-activity';
import {
  sessionJobLabels,
  sessionJobEventDetail,
} from '@/lib/session-preparation-job-events';
import { useTradeSessionActivity } from './use-trade-session-activity';
import {
  sessionEventLabels,
  sessionEventDetail,
} from '@/lib/imported-trade-session-events';
import { importedAcquisitionDetail } from '@/lib/imported-acquisition';
import { swapFailureDetail } from '@/lib/swap-failure';

import { useEffect, useState } from 'react';
import { Activity, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { WorkspaceProject } from '@/lib/workspace-project';
import type { FundingEvent } from '@/lib/funding-plan';
import { useProjectHistory } from './use-project-history';
import { useWalletAudit } from './use-wallet-audit';
import type { WalletAuditEvent } from '@/lib/distribution-audit';
import { FundingActivityHistory } from './funding-activity-history';
import { useImportedActivity } from './use-imported-activity';
import { useWarmupActivity } from './use-warmup-activity';
import { useWarmupRunActivity } from './use-warmup-run-activity';
import { historyRunEventLabel } from '@/lib/warmup-history-run-events';
import { WarmupActivityDetails } from './warmup-activity-details';
import { useWarmupPreparationActivity } from './use-warmup-preparation-activity';
import { useImportedPreparationActivity } from './use-imported-preparation-activity';
import type { SavedSwapPreparation } from '@/lib/imported-swap-preparation-history';
import { PreparationHistoryRecord } from './imported-preparation-history';
import type { SavedWarmupPreparation } from '@/lib/warmup-preparation-history';
import { useWarmupSigningActivity } from './use-warmup-signing-activity';
import { warmupSigningEventLabel } from '@/lib/warmup-signing-events';
import { useImportedSigningActivity } from './use-imported-signing-activity';
import { importedSigningEventLabel } from '@/lib/imported-signing-events';
import { useWithdrawalActivity } from './use-withdrawal-activity';
import {
  withdrawalActivityDetail,
  withdrawalActivityLabel,
  type WithdrawalActivityEvent,
} from '@/lib/withdrawal-activity';
import { WithdrawalActivityRecord } from './withdrawal-activity-record';
import { useJitoBundleActivity } from './use-jito-bundle-activity';
import {
  jitoBundleEventLabel,
  jitoBundleEventDetail,
} from '@/lib/jito-bundle-events';

function receiptFundingId(event: WalletAuditEvent): string | undefined {
  if (
    ![
      'native_transfer_finalized',
      'native_transfer_failed',
      'token_transfer_finalized',
      'token_transfer_failed',
    ].includes(event.eventType)
  )
    return;
  try {
    const details = JSON.parse(event.details) as Record<string, unknown>;
    return typeof details.fundingId === 'string' &&
      /^[a-zA-Z0-9-]{1,64}$/.test(details.fundingId)
      ? details.fundingId
      : undefined;
  } catch {
    return;
  }
}

function walletDetail(event: WalletAuditEvent) {
  const parts = [event.walletAddress, event.eventType.replaceAll('_', ' ')];
  try {
    const details = JSON.parse(event.details) as Record<string, unknown>;
    if (
      ['token_transfer_finalized', 'token_transfer_failed'].includes(
        event.eventType,
      ) &&
      typeof details.amount === 'string' &&
      typeof details.mint === 'string' &&
      typeof details.recipient === 'string'
    ) {
      parts.push(
        `${details.amount} tokens${event.eventType === 'token_transfer_failed' ? ' requested; not delivered' : ''}`,
        `mint ${details.mint}`,
        `recipient ${details.recipient}`,
      );
    }
    if (typeof details.slot === 'number') parts.push(`slot ${details.slot}`);
    if (
      ['native_transfer_finalized', 'native_transfer_failed'].includes(
        event.eventType,
      ) &&
      typeof details.amount === 'string' &&
      typeof details.recipient === 'string'
    )
      parts.push(
        `${details.amount} SOL${event.eventType === 'native_transfer_failed' ? ' requested; not delivered' : ''}`,
        `recipient ${details.recipient}`,
        typeof details.fundingId === 'string'
          ? `funding ${details.fundingId}`
          : 'funding draft',
      );
    if (typeof details.feeLamports === 'string')
      parts.push(`network fee ${details.feeLamports} lamports`);
    if (typeof details.transactionError === 'string')
      parts.push(`failure ${details.transactionError}`);
  } catch {
    parts.push('Details unavailable');
  }
  return parts.join(' · ');
}

type Cycle = {
  id: string;
  createdAt: string;
  strategy: string;
  network: string;
  status: string;
  plannedOrders: number;
};

export function WorkspaceActivity({
  projects,
  onOpen,
  onOpenImport,
  onOpenWarmup,
  onOpenWithdrawal,
}: {
  projects: WorkspaceProject[];
  onOpen: (project: WorkspaceProject) => void;
  onOpenImport: (id: string) => void;
  onOpenWarmup: (id: string) => void;
  onOpenWithdrawal?: (wallet: string) => void;
}) {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [fundingEvents, setFundingEvents] = useState<FundingEvent[]>([]);
  const [fundingError, setFundingError] = useState('');
  const [fundingLoading, setFundingLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [network, setNetwork] = useState('All networks');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const projectHistory = useProjectHistory(revision);
  const sessionHistory = useTradeSessionActivity(revision);
  const jobHistory = useSessionJobActivity(revision);
  const importedHistory = useImportedActivity(revision);
  const warmupHistory = useWarmupActivity(revision);
  const warmupRunHistory = useWarmupRunActivity(revision);
  const warmupSigningHistory = useWarmupSigningActivity(revision);
  const importedSigningHistory = useImportedSigningActivity(revision);
  const withdrawalHistory = useWithdrawalActivity(revision);
  const jitoHistory = useJitoBundleActivity(revision);
  const [withdrawalDetail, setWithdrawalDetail] =
    useState<WithdrawalActivityEvent | null>(null);
  const preparationHistory = useWarmupPreparationActivity(revision);
  const importedPreparations = useImportedPreparationActivity(revision);
  const [importedPreparationDetail, setImportedPreparationDetail] =
    useState<SavedSwapPreparation | null>(null);
  const [preparationDetail, setPreparationDetail] =
    useState<SavedWarmupPreparation | null>(null);
  const [warmupDetail, setWarmupDetail] = useState<{
    id: string;
    run?: { id: string; revision: number };
  } | null>(null);
  const walletHistory = useWalletAudit('', revision);
  const [category, setCategory] = useState('All');
  const [period, setPeriod] = useState('All time');
  const [search, setSearch] = useState('');
  const [observedThrough, setObservedThrough] = useState(Date.now);
  const [fundingDetail, setFundingDetail] = useState<{
    id: string;
    name: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/funding/events', {
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = (await response.json()) as {
          events: FundingEvent[];
          nextCursor: string | null;
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || 'Funding history unavailable.');
        if (!controller.signal.aborted) {
          setFundingEvents(data.events);
          setCursor(data.nextCursor);
          setFundingError('');
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setFundingError(
            e instanceof Error ? e.message : 'Funding history unavailable.',
          );
          setFundingEvents([]);
          setCursor(null);
        }
      } finally {
        if (!controller.signal.aborted) setFundingLoading(false);
      }
    })();
    return () => controller.abort();
  }, [revision]);
  async function olderFunding() {
    if (!cursor) return;
    setFundingLoading(true);
    try {
      const response = await fetch(
        `/api/funding/events?cursor=${encodeURIComponent(cursor)}`,
        { cache: 'no-store' },
      );
      const data = (await response.json()) as {
        events: FundingEvent[];
        nextCursor: string | null;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Funding history unavailable.');
      setFundingEvents((rows) => [
        ...rows,
        ...data.events.filter((event) => !rows.some((r) => r.id === event.id)),
      ]);
      setCursor(data.nextCursor);
      setFundingError('');
    } catch (e) {
      setFundingError(
        e instanceof Error ? e.message : 'Funding history unavailable.',
      );
    } finally {
      setFundingLoading(false);
    }
  }
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const response = await fetch('/api/pulse/cycles', {
          cache: 'no-store',
        });
        const data = (await response.json()) as {
          error?: string;
          cycles?: Cycle[];
        };
        if (!response.ok)
          throw new Error(data.error || 'Audit cycles unavailable.');
        if (!Array.isArray(data.cycles))
          throw new Error('Invalid activity response.');
        if (current) {
          setCycles(data.cycles);
          setError('');
        }
      } catch (e) {
        if (current) {
          setCycles([]);
          setError(
            e instanceof Error ? e.message : 'Audit cycles unavailable.',
          );
        }
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [revision]);
  const cutoff =
    period === 'All time'
      ? 0
      : observedThrough -
        (period === '1 day' ? 1 : period === '7 days' ? 7 : 30) * 86400000;
  const rows = [
    ...jitoHistory.events.map((record) => ({
      id: `jito:${record.id}`,
      date: record.createdAt,
      category: 'Bundles',
      network: 'Solana mainnet',
      title: jitoBundleEventLabel(record),
      detail: jitoBundleEventDetail(record),
      importedId: record.projectId,
      warmupId: undefined,
      run: undefined,
      project: undefined,
      fundingId: undefined,
      href: undefined,
    })),
    ...withdrawalHistory.events.map((event) => ({
      id: `withdrawal:${event.sequence}`,
      date: event.createdAt,
      category: 'Withdrawals',
      network: 'Solana mainnet',
      title: withdrawalActivityLabel(event.withdrawal.state),
      detail: withdrawalActivityDetail(event),
      importedId: undefined,
      warmupId: undefined,
      run: undefined,
      project: undefined,
      fundingId: undefined,
      href: event.withdrawal.signature
        ? `https://explorer.solana.com/tx/${encodeURIComponent(event.withdrawal.signature)}`
        : undefined,
    })),
    ...jobHistory.events.map((event) => ({
      id: `session-job:${event.id}`,
      date: event.createdAt,
      category: 'Imports',
      network: 'Solana mainnet',
      title: sessionJobLabels[event.document.state],
      detail: sessionJobEventDetail(event),
      importedId: event.projectId,
      warmupId: undefined,
      run: undefined,
      project: undefined,
      fundingId: undefined,
      href: undefined,
    })),
    ...sessionHistory.events.map((event) => ({
      id: `trade-session:${event.id}`,
      date: event.createdAt,
      category: 'Imports',
      network: 'Solana mainnet',
      title: `${event.document.terms.side} · ${sessionEventLabels[event.type]}`,
      detail: sessionEventDetail(event),
      importedId: event.projectId,
      warmupId: undefined,
      run: undefined,
      project: undefined,
      fundingId: undefined,
      href: event.approval?.signature
        ? `https://explorer.solana.com/tx/${encodeURIComponent(event.approval.signature)}`
        : undefined,
    })),
    ...importedSigningHistory.events.map((event) => ({
      id: `imported-signing:${event.id}`,
      date: event.createdAt,
      category: 'Imports',
      network: 'Solana mainnet',
      title: `${event.document.side} · ${importedSigningEventLabel(event.type)}`,
      detail: `Project ${event.projectId} · revision ${event.projectRevision} · wallet revision ${event.walletRevision} · ${event.wallet} · captured state ${event.state} · approval ${event.intentId} · preparation ${event.preparationId} · packet ${event.document.sha256} · input ${event.document.inputRaw} atomic units of ${event.document.inputMint} · minimum output ${event.document.minimumOutputRaw} atomic units of ${event.document.outputMint}${event.document.acquisition ? ' · ' + importedAcquisitionDetail(event.document.acquisition) : ''}${event.signature ? ' · registered signature ' + event.signature : ''}${event.type === 'approval.baseline' ? ' · prior transitions were not reconstructed' : ''}${event.state === 'failed' ? ' · ' + (event.failureReceipt ? swapFailureDetail(event.failureReceipt) : 'Failure fee and error evidence was not captured at this transition') : ''}`,
      importedId: event.projectId,
      warmupId: undefined,
      run: undefined,
      project: undefined,
      fundingId: undefined,
      href: event.signature
        ? `https://explorer.solana.com/tx/${encodeURIComponent(event.signature)}`
        : undefined,
    })),
    ...warmupSigningHistory.events.map((event) => ({
      id: `warmup-signing:${event.id}`,
      date: event.createdAt,
      category: 'Warmup',
      network: 'Solana mainnet',
      title: `${event.document.side} · ${warmupSigningEventLabel(event.type)}`,
      detail: `Plan ${event.planId} · revision ${event.planRevision} · cycle ${event.cycle} · ${event.wallet} · captured state ${event.state} · input ${event.document.inputRaw} atomic units of ${event.document.inputMint} · minimum output ${event.document.minimumOutputRaw} atomic units of ${event.document.outputMint}${event.type === 'approval.baseline' ? ' · prior transitions were not reconstructed' : ''}${event.state === 'failed' ? ' · ' + (event.failureReceipt ? swapFailureDetail(event.failureReceipt) : 'Failure fee and error evidence was not captured at this transition') : ''}`,
      warmupId: event.planId,
      run: undefined,
      importedId: undefined,
      project: undefined,
      fundingId: undefined,
      href: event.signature
        ? `https://explorer.solana.com/tx/${encodeURIComponent(event.signature)}`
        : undefined,
    })),
    ...importedPreparations.events.map((event) => ({
      id: `imported-preparation:${event.id}`,
      date: event.createdAt,
      category: 'Imports',
      network: 'Solana',
      title: `Unsigned ${event.document.side.toLowerCase()} review`,
      detail: `Project ${event.projectId} · revision ${event.projectRevision} · ${event.document.wallet} · ${event.document.simulation.succeeded ? 'Simulation completed' : 'Simulation failed'} · no transaction submitted`,
      warmupId: undefined,
      run: undefined,
      importedId: event.projectId,
      project: undefined,
      fundingId: undefined,
      href: undefined,
    })),
    ...preparationHistory.events.map((event) => ({
      id: `warmup-preparation:${event.id}`,
      date: event.createdAt,
      category: 'Warmup',
      network: 'Solana',
      title: `Unsigned ${event.document.side.toLowerCase()} review`,
      detail: `Plan ${event.planId} · revision ${event.planRevision} · cycle ${event.cycle} · ${event.document.wallet} · ${event.document.simulation.succeeded ? 'Simulation completed' : 'Simulation failed'} · no transaction submitted`,
      preparation: event,
      warmupId: undefined,
      run: undefined,
      importedId: undefined,
      project: undefined,
      fundingId: undefined,
      href: undefined,
    })),
    ...warmupRunHistory.events.map((event) => ({
      id: `warmup-run:${event.id}`,
      date: event.createdAt,
      category: 'Warmup',
      network: event.chain,
      title: event.name,
      detail: `${historyRunEventLabel(event.type)} · plan revision ${event.planRevision} · run revision ${event.revision} · ${event.state} · ${event.completedCount}/${event.walletCount} checked · ${event.errorCount} failed${event.walletAddress ? ` · ${event.walletAddress}` : ''} · public history review, no trades`,
      warmupId: event.planId,
      run: { id: event.runId, revision: event.revision },
      importedId: undefined,
      project: undefined,
      fundingId: undefined,
      href: undefined,
    })),
    ...warmupHistory.events.map((event) => ({
      id: `warmup:${event.id}`,
      date: event.createdAt,
      category: 'Warmup',
      network: event.summary.chain,
      title: event.summary.name,
      detail: `${event.type === 'plan.create' ? 'Plan created' : event.type === 'plan.save' ? 'Configuration saved' : event.type === 'plan.archive' ? 'Plan archived' : 'Plan restored'} · revision ${event.revision} · ${event.summary.walletCount} wallets · ${event.summary.cycles} cycles · buy ${event.summary.amount} · total budget ${event.summary.totalBudget} · no swaps scheduled`,
      warmupId: event.planId,
      run: undefined,
      importedId: undefined,
      project: undefined,
      fundingId: undefined,
      href: undefined,
    })),
    ...importedHistory.events.map((event) => ({
      id: `import:${event.id}`,
      date: event.createdAt,
      category: 'Imports',
      network: event.token.chain,
      title: `${event.token.name} (${event.token.symbol})`,
      detail: `${event.type === 'project.settings' ? 'Trade settings saved' : event.type === 'project.refresh' ? 'Identity refreshed' : event.type === 'project.archive' ? 'Project archived' : event.type === 'project.restore' ? 'Project restored' : 'Token imported'} · revision ${event.revision} · ${event.token.address} · no trade submitted`,
      importedId: event.projectId,
      warmupId: undefined,
      run: undefined,
      project: undefined,
      fundingId: undefined,
      href: undefined,
    })),
    ...walletHistory.events.map((event) => ({
      id: `wallet:${event.id}`,
      warmupId: undefined,
      run: undefined,
      importedId: undefined,
      date: event.createdAt,
      category: 'Wallets',
      network: 'Solana devnet',
      title:
        event.eventType === 'ownership_verified'
          ? 'Wallet ownership verified'
          : event.eventType === 'native_transfer_finalized'
            ? 'Native SOL funding finalized'
            : event.eventType === 'native_transfer_failed'
              ? 'Native SOL funding failed'
              : event.eventType === 'token_transfer_finalized'
                ? 'Token transfer finalized'
                : event.eventType === 'token_transfer_failed'
                  ? 'Token transfer failed'
                  : event.eventType === 'memo_failed'
                    ? 'Devnet memo failed'
                    : event.eventType === 'memo_finalized'
                      ? 'Devnet memo finalized'
                      : 'Wallet activity',
      detail: walletDetail(event),
      project: undefined,
      fundingId: receiptFundingId(event),
      href: event.transactionSignature
        ? `https://explorer.solana.com/tx/${encodeURIComponent(event.transactionSignature)}?cluster=devnet`
        : undefined,
    })),
    ...fundingEvents.map((event) => ({
      id: `funding:${event.id}`,
      warmupId: undefined,
      run: undefined,
      importedId: undefined,
      date: event.createdAt,
      category: 'Funding',
      network: event.chain,
      title: event.name,
      detail: `${event.type.replace('funding.', 'Funding draft ')} · revision ${event.revision} · no funds moved`,
      project: undefined,
      fundingId: event.planId,
      href: undefined,
    })),
    ...projectHistory.events.map((event) => ({
      id: `project-event:${event.id}`,
      warmupId: undefined,
      run: undefined,
      importedId: undefined,
      date: event.createdAt,
      category: 'Projects',
      network: event.chain,
      title: event.name,
      detail: `${event.type.replace('project.', 'Project ')} · ${event.launchpad}${event.changes.length ? ` · Changed: ${event.changes.join(', ')}` : ''}`,
      project: projects.find((project) => project.id === event.projectId),
      fundingId: undefined,
      href: undefined,
    })),
    ...cycles.map((cycle) => ({
      id: `cycle:${cycle.id}`,
      warmupId: undefined,
      run: undefined,
      importedId: undefined,
      date: cycle.createdAt,
      category: 'Simulation',
      network: cycle.network,
      title: `${cycle.strategy} audit cycle`,
      detail: `${cycle.status} · ${cycle.plannedOrders} planned orders · no transactions submitted`,
      project: undefined,
      fundingId: undefined,
      href: undefined,
    })),
  ]
    .filter(
      (row) =>
        (category === 'All' || row.category === category) &&
        (network === 'All networks' || row.network === network) &&
        Date.parse(row.date) >= cutoff &&
        `${row.title} ${row.detail} ${row.network}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return (
    <section className="project-dashboard workspace-activity">
      <header className="dashboard-heading">
        <div>
          <span className="eyebrow">WORKSPACE RECORDS</span>
          <h1>Activity</h1>
          <p>
            Funding, project and wallet history, plus read-only audit cycles.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setLoading(true);
            setFundingLoading(true);
            projectHistory.beginRefresh();
            sessionHistory.beginRefresh();
            jobHistory.beginRefresh();
            importedHistory.beginRefresh();
            warmupHistory.beginRefresh();
            warmupRunHistory.beginRefresh();
            warmupSigningHistory.beginRefresh();
            importedSigningHistory.beginRefresh();
            withdrawalHistory.beginRefresh();
            jitoHistory.beginRefresh();
            preparationHistory.beginRefresh();
            importedPreparations.beginRefresh();
            setObservedThrough(Date.now());
            setRevision((v) => v + 1);
          }}
          disabled={
            loading ||
            fundingLoading ||
            projectHistory.loading ||
            sessionHistory.loading ||
            jobHistory.loading ||
            importedHistory.loading ||
            warmupHistory.loading ||
            warmupRunHistory.loading ||
            warmupSigningHistory.loading ||
            importedSigningHistory.loading ||
            withdrawalHistory.loading ||
            jitoHistory.loading ||
            preparationHistory.loading ||
            importedPreparations.loading ||
            walletHistory.loading
          }
        >
          <RefreshCw /> Refresh records
        </Button>
      </header>
      <div className="tracker-disclosure">
        <Activity size={16} />
        <span>
          Saves, archives and restores are recorded as separate events. Project
          history begins with this update; older changes are not reconstructed.
          Filters apply to loaded records, including up to 12 retained Pulse
          cycles. Selecting a project opens its latest saved version. Funding
          history opens the latest draft, including archived drafts, and its
          retained execution receipts. Imported project links open the latest
          saved import, including archived projects; identity and settings
          events are not trade receipts. Warmup links open the latest saved
          configuration and its history, including archived plans; configuration
          events do not establish trades. Public history run transitions retain
          captured plan revisions; their names use the latest saved plan.
          Earlier runs have a retained-state baseline. Completed checks may
          include provider failures and do not establish wallet readiness. Saved
          unsigned reviews retain their original plan revision and cycle,
          including archived plans. Simulations are not execution receipts.
          Imported swap reviews also retain their captured project revision and
          can be reopened after the project is archived. Imported and warmup
          execution transitions retain the exact approval and signature. A
          registered signature is not a sent transaction. A submission attempt
          can have an uncertain outcome; only a matching finalized receipt
          establishes completion. Earlier approvals have a retained-state
          baseline. Withdrawal transitions retain the captured state, wallet
          revision and exact review. A registered signature or submission
          attempt does not establish delivery. Only a verified finalized
          withdrawal receipt records recipient credit. Jito transitions retain
          state and signature progress at each recorded change. Earlier bundles
          have a retained-state baseline; transitions before that baseline are
          not reconstructed.
        </span>
      </div>
      <div className="project-toolbar">
        <div className="tracker-tabs" aria-label="Activity categories">
          {[
            'All',
            'Funding',
            'Projects',
            'Imports',
            'Warmup',
            'Wallets',
            'Withdrawals',
            'Bundles',
            'Simulation',
          ].map((value) => (
            <button
              key={value}
              aria-pressed={category === value}
              onClick={() => setCategory(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <select
          aria-label="Activity network"
          value={network}
          onChange={(e) => setNetwork(e.target.value)}
        >
          {[
            'All networks',
            ...new Set([
              ...projects.map((p) => p.plan.chain),
              ...cycles.map((c) => c.network),
              ...fundingEvents.map((e) => e.chain),
              ...projectHistory.events.map((e) => e.chain),
              ...sessionHistory.events.map(() => 'Solana mainnet'),
              ...jobHistory.events.map(() => 'Solana mainnet'),
              ...importedHistory.events.map((e) => e.token.chain),
              ...warmupHistory.events.map((e) => e.summary.chain),
              ...warmupRunHistory.events.map((e) => e.chain),
              ...warmupSigningHistory.events.map(() => 'Solana mainnet'),
              ...importedSigningHistory.events.map(() => 'Solana mainnet'),
              ...withdrawalHistory.events.map(() => 'Solana mainnet'),
              ...jitoHistory.events.map(() => 'Solana mainnet'),
              ...preparationHistory.events.map(() => 'Solana'),
              ...importedPreparations.events.map(() => 'Solana'),
              ...walletHistory.events.map(() => 'Solana devnet'),
            ]),
          ].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="Activity period"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        >
          {['All time', '30 days', '7 days', '1 day'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <div className="project-search">
          <Search />
          <Input
            aria-label="Search activity"
            placeholder="Search activity…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="tracker-error">
          {error} Project updates remain visible.
        </p>
      )}
      {fundingError && (
        <p role="alert" className="tracker-error">
          {fundingError}
        </p>
      )}
      {projectHistory.error && (
        <p role="alert" className="tracker-error">
          {projectHistory.error}
        </p>
      )}
      {walletHistory.error && (
        <p role="alert" className="tracker-error">
          {walletHistory.error}
        </p>
      )}
      {fundingDetail && (
        <FundingActivityHistory
          key={fundingDetail.id}
          id={fundingDetail.id}
          eventName={fundingDetail.name}
          refreshRevision={revision}
          onClose={() => setFundingDetail(null)}
        />
      )}
      {jitoHistory.baselinePending && (
        <div className="tracker-disclosure">
          <span>
            Earlier bundles have no recorded timeline. Record their current
            state as a baseline; past transitions will not be reconstructed.
            Each click records up to 50 bundles.
          </span>
          <Button
            variant="outline"
            disabled={jitoHistory.loading}
            onClick={jitoHistory.baseline}
          >
            Record earlier bundle baselines
          </Button>
        </div>
      )}
      {jitoHistory.error && <p role="alert">{jitoHistory.error}</p>}
      {withdrawalHistory.error && (
        <p role="alert" className="tracker-error">
          {withdrawalHistory.error}
        </p>
      )}
      {withdrawalDetail && (
        <WithdrawalActivityRecord
          event={withdrawalDetail}
          onClose={() => setWithdrawalDetail(null)}
          onOpenWallet={onOpenWithdrawal}
        />
      )}
      {jobHistory.error && <p role="alert">{jobHistory.error}</p>}
      {sessionHistory.error && (
        <p role="alert" className="tracker-error">
          {sessionHistory.error}
        </p>
      )}
      {importedHistory.error && (
        <p role="alert" className="tracker-error">
          {importedHistory.error}
        </p>
      )}
      {warmupHistory.error && (
        <p role="alert" className="tracker-error">
          {warmupHistory.error}
        </p>
      )}
      {warmupRunHistory.error && (
        <p role="alert" className="tracker-error">
          {warmupRunHistory.error}
        </p>
      )}
      {warmupSigningHistory.error && (
        <p role="alert" className="tracker-error">
          {warmupSigningHistory.error}
        </p>
      )}
      {importedSigningHistory.error && (
        <p role="alert" className="tracker-error">
          {importedSigningHistory.error}
        </p>
      )}
      {warmupDetail && (
        <WarmupActivityDetails
          key={`${warmupDetail.id}:${warmupDetail.run?.id ?? 'plan'}`}
          id={warmupDetail.id}
          run={warmupDetail.run}
          refreshRevision={revision}
          onClose={() => setWarmupDetail(null)}
          onOpenWallets={onOpenWarmup}
        />
      )}
      {preparationHistory.error && (
        <p role="alert" className="tracker-error">
          {preparationHistory.error}
        </p>
      )}
      {preparationDetail && (
        <section aria-label="Saved warmup preparation review">
          <Button variant="outline" onClick={() => setPreparationDetail(null)}>
            Close saved review
          </Button>
          <Button
            variant="outline"
            onClick={() => onOpenWarmup(preparationDetail.planId)}
          >
            Open warmup plan
          </Button>
          <PreparationHistoryRecord
            record={{
              ...preparationDetail,
              projectId: preparationDetail.planId,
              projectRevision: preparationDetail.planRevision,
            }}
            projectRevision={preparationDetail.planRevision}
            contextLabel="plan"
          />
        </section>
      )}
      <div className="project-table-wrap">
        {importedPreparations.error && (
          <p role="alert" className="tracker-error">
            {importedPreparations.error}
          </p>
        )}
        {importedPreparationDetail && (
          <section aria-label="Saved imported swap preparation review">
            <Button
              variant="outline"
              onClick={() => setImportedPreparationDetail(null)}
            >
              Close saved imported review
            </Button>
            <Button
              variant="outline"
              onClick={() => onOpenImport(importedPreparationDetail.projectId)}
            >
              Open imported project
            </Button>
            <PreparationHistoryRecord
              record={importedPreparationDetail}
              projectRevision={importedPreparationDetail.projectRevision}
            />
          </section>
        )}
        <table className="project-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Network</th>
              <th>Category</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.project ? (
                    <button
                      className="activity-project"
                      onClick={() => onOpen(row.project!)}
                    >
                      <strong>{row.title}</strong>
                      <small>{row.detail}</small>
                    </button>
                  ) : row.href ? (
                    <a
                      className="activity-project"
                      href={row.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <strong>{row.title}</strong>
                      <small>{row.detail}</small>
                    </a>
                  ) : (
                    <>
                      <strong>{row.title}</strong>
                      <small>{row.detail}</small>
                    </>
                  )}
                  {row.fundingId && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setFundingDetail({
                          id: row.fundingId!,
                          name: row.title,
                        })
                      }
                    >
                      View funding history
                    </Button>
                  )}
                  {row.id.startsWith('withdrawal:') && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setWithdrawalDetail(
                          withdrawalHistory.events.find(
                            (event) =>
                              `withdrawal:${event.sequence}` === row.id,
                          ) ?? null,
                        )
                      }
                    >
                      View withdrawal record
                    </Button>
                  )}
                  {row.id.startsWith('warmup-preparation:') && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setImportedPreparationDetail(null);
                        setPreparationDetail(
                          preparationHistory.events.find(
                            (event) =>
                              `warmup-preparation:${event.id}` === row.id,
                          ) ?? null,
                        );
                      }}
                    >
                      View saved unsigned review
                    </Button>
                  )}
                  {row.importedId && (
                    <Button
                      variant="outline"
                      onClick={() => onOpenImport(row.importedId!)}
                    >
                      Open imported project
                    </Button>
                  )}
                  {row.id.startsWith('imported-preparation:') && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setPreparationDetail(null);
                        setImportedPreparationDetail(
                          importedPreparations.events.find(
                            (event) =>
                              `imported-preparation:${event.id}` === row.id,
                          ) ?? null,
                        );
                      }}
                    >
                      View saved imported review
                    </Button>
                  )}
                  {row.warmupId && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setWarmupDetail({ id: row.warmupId!, run: row.run })
                      }
                    >
                      {row.run
                        ? 'View warmup run timeline'
                        : 'Open saved warmup'}
                    </Button>
                  )}
                </td>
                <td>{row.network}</td>
                <td>
                  <span className="draft-badge">{row.category}</span>
                </td>
                <td>
                  <time dateTime={row.date}>
                    {new Date(row.date).toLocaleString()}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <div className="project-empty">
            <Activity />
            <h2>
              {loading ||
              fundingLoading ||
              projectHistory.loading ||
              sessionHistory.loading ||
              jobHistory.loading ||
              importedHistory.loading ||
              warmupHistory.loading ||
              warmupRunHistory.loading ||
              warmupSigningHistory.loading ||
              importedSigningHistory.loading ||
              withdrawalHistory.loading ||
              jitoHistory.loading ||
              preparationHistory.loading ||
              importedPreparations.loading ||
              walletHistory.loading
                ? 'Loading activity…'
                : 'No matching records'}
            </h2>
            <p>
              {category === 'Withdrawals'
                ? 'Withdrawal reviews, signing, submission and finalized outcomes appear here. Start a withdrawal from My wallets.'
                : 'Save a project or run a read-only audit cycle to see it here.'}
            </p>
          </div>
        )}
      </div>
      {jitoHistory.cursor && (
        <Button
          variant="outline"
          disabled={jitoHistory.loading}
          onClick={jitoHistory.older}
        >
          Load older Jito events
        </Button>
      )}
      {cursor && (
        <Button
          variant="outline"
          disabled={fundingLoading || loading}
          onClick={() => void olderFunding()}
        >
          {fundingLoading ? 'Loading…' : 'Load older funding events'}
        </Button>
      )}
      {projectHistory.cursor && (
        <Button
          variant="outline"
          disabled={projectHistory.loading}
          onClick={() => void projectHistory.older()}
        >
          {projectHistory.loading ? 'Loading…' : 'Load older project events'}
        </Button>
      )}
      {walletHistory.cursor && (
        <Button
          variant="outline"
          disabled={walletHistory.loading}
          onClick={() => void walletHistory.older()}
        >
          Load older wallet events
        </Button>
      )}
      {jobHistory.cursor && (
        <Button
          variant="outline"
          disabled={jobHistory.loading}
          onClick={jobHistory.older}
        >
          Load older preparation job events
        </Button>
      )}
      {sessionHistory.cursor && (
        <Button
          variant="outline"
          disabled={sessionHistory.loading}
          onClick={sessionHistory.older}
        >
          Load older trade session events
        </Button>
      )}
      {importedHistory.cursor && (
        <Button
          variant="outline"
          disabled={importedHistory.loading}
          onClick={importedHistory.older}
        >
          Load older imported events
        </Button>
      )}
      {warmupRunHistory.cursor && (
        <Button
          variant="outline"
          disabled={warmupRunHistory.loading}
          onClick={warmupRunHistory.older}
        >
          Load older warmup run events
        </Button>
      )}
      {warmupSigningHistory.cursor && (
        <Button
          variant="outline"
          disabled={warmupSigningHistory.loading}
          onClick={warmupSigningHistory.older}
        >
          Load older warmup execution events
        </Button>
      )}
      {importedSigningHistory.cursor && (
        <Button
          variant="outline"
          disabled={importedSigningHistory.loading}
          onClick={importedSigningHistory.older}
        >
          Load older imported swap events
        </Button>
      )}
      {withdrawalHistory.cursor && (
        <Button
          variant="outline"
          disabled={withdrawalHistory.loading}
          onClick={withdrawalHistory.older}
        >
          Load older withdrawal events
        </Button>
      )}
      {warmupHistory.cursor && (
        <Button
          variant="outline"
          disabled={warmupHistory.loading}
          onClick={warmupHistory.older}
        >
          Load older warmup events
        </Button>
      )}
      {preparationHistory.cursor && (
        <Button
          variant="outline"
          disabled={preparationHistory.loading}
          onClick={preparationHistory.older}
        >
          Load older warmup reviews
        </Button>
      )}
      {importedPreparations.cursor && (
        <Button
          variant="outline"
          disabled={importedPreparations.loading}
          onClick={importedPreparations.older}
        >
          Load older imported reviews
        </Button>
      )}
    </section>
  );
}
