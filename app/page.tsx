'use client';
import { OPEN_IMPORTED_PROJECT_EVENT } from '@/lib/open-launch-chart';
import type { NarrativeDraft } from '@/lib/narratives';
import {
  validateHoldersQuoteAmount,
  holdersBuyUnit,
  holdersQuoteAfterPlanChange,
} from '@/lib/launch-buy';
import {
  validateSequencedSupply,
  developerBuyAfterPlanChange,
} from '@/lib/launch-supply';

import { validateQuoteSelection } from '@/lib/quote-catalog';
import {
  timingAfterPlanChange,
  validateLaunchTiming,
} from '@/lib/launch-timing';
import { HolderDistributionForm } from '@/components/launch/holder-distribution-form';
import { LaunchBuyForm } from '@/components/launch/launch-buy-form';
import { LaunchTimingForm } from '@/components/launch/launch-timing-form';
import { LaunchWalletPicker } from '@/components/launch/launch-wallet-picker';
import { validateLaunchWalletSelection } from '@/lib/launch-wallets';
import {
  modeAfterVenueChange,
  venueLaunchMethods,
  validateLaunchMethod,
} from '@/lib/launch-methods';

import { venueLimits, validateVenuePlan } from '@/lib/venue-limits';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import Link from 'next/link';
import {
  Activity,
  Boxes,
  ChevronDown,
  CircleGauge,
  CircleHelp,
  Crosshair,
  Database,
  Gauge,
  Hand,
  Landmark,
  Leaf,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Download,
  ShoppingCart,
  Settings,
  Shield,
  Search,
  LayoutDashboard,
  Archive,
  BarChart3,
  Bot,
  CircleDollarSign,
  Play,
  Radio,
  RefreshCw,
  Rocket,
  SlidersHorizontal,
  Target,
  TimerReset,
  TrendingUp,
  TriangleAlert,
  Users,
  WalletCards,
  Waves,
  Zap,
} from 'lucide-react';
import { DraftRevision } from '@/lib/draft-revision';
import { RobinhoodPlanner } from '@/components/launch/robinhood-planner';
import { canUseDevnetTools } from '@/lib/workspace-capabilities';
import { ChainLaunchForm } from '@/components/launch/chain-launch-form';
import { FundingForm } from '@/components/launch/funding-form';
import { LiveOperationsForm } from '@/components/launch/live-operations-form';
import { PlanRail } from '@/components/launch/plan-rail';
import { LaunchWalletTable } from '@/components/launch/launch-wallet-table';
import { LaunchWorkspacePanels } from '@/components/launch/launch-workspace-panels';
import { SidebarFunder } from '@/components/sidebar-funder';
import { VenueMark } from '@/components/launch/venue-mark';
import { LaunchSetupDialog } from '@/components/launch/launch-setup-dialog';
import { TokenDetailsForm } from '@/components/launch/token-details-form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { SupplyTracker } from '@/components/supply-tracker';
import { StatusPrices } from '@/components/status-prices';
import { DistributionWorkbench } from '@/components/distribution-workbench';
import { ProjectDashboard } from '@/components/project-dashboard';
import {
  ProjectSharePanel,
  SharedProjectsPanel,
} from '@/components/project-sharing';
import { WalletWorkspace } from '@/components/wallet-workspace';
import { WalletTracker } from '@/components/wallet-tracker';
import { WorkspaceActivity } from '@/components/workspace-activity';
import { ImportedTokenProjects } from '@/components/imported-token-projects';
import { useImportedProjects } from '@/components/use-imported-projects';
import { PumpTokenWorkspaceNavigation } from '@/components/launch/pump-token-workspace-navigation';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
  type TokenIdentity,
  type VenueOptions,
  type WorkspaceProject,
} from '@/lib/workspace-project';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  DEFAULT_LAUNCH_PLAN,
  deriveIllustrativeLaunchEstimate,
  launchModeLabel,
  validateLaunchPlan,
  type LaunchMode as Mode,
  type LaunchPlanInput,
  type LaunchPreset as Preset,
  type SavedLaunchPlan,
} from '@/lib/launch-plan';

type View =
  | 'dashboard'
  | 'archived'
  | 'wallets'
  | 'watchlist'
  | 'activity'
  | 'imports'
  | 'chain'
  | 'token'
  | 'launch'
  | 'funding'
  | 'distribution'
  | 'live'
  | 'pulse'
  | 'tracker';
// Workspace pages are not part of the launch draft, so the topbar and status bar
// drop draft-editing chrome there and show the page location instead.
const SIDEBAR_COLLAPSED_KEY = 'bundle:sidebar-collapsed';
const sidebarListeners = new Set<() => void>();
// Used when browser storage is unavailable, so the toggle still works.
let sidebarCollapsedFallback = false;

function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return sidebarCollapsedFallback;
  }
}

function writeSidebarCollapsed(collapsed: boolean) {
  sidebarCollapsedFallback = collapsed;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage can be unavailable; the fallback keeps this visit's choice.
  }
  sidebarListeners.forEach((listener) => listener());
}

function subscribeSidebarCollapsed(listener: () => void) {
  sidebarListeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    sidebarListeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}
const PLAN_TOOL_VIEWS: readonly View[] = [
  'funding',
  'distribution',
  'live',
  'pulse',
];

const WORKSPACE_TITLES: Partial<Record<View, string>> = {
  dashboard: 'Dashboard',
  archived: 'Archived',
  wallets: 'My wallets',
  tracker: 'Supply tracker',
  watchlist: 'Wallet tracker',
  activity: 'Activity',
  imports: 'Imported token',
};
type Strategy = 'Balanced' | 'Liquidity' | 'Discovery';
const presets: Array<{
  name: Preset;
  blurb: string;
  icon: typeof Zap;
  mev: number;
}> = [
  { name: 'Quick', blurb: 'Simple scenario', icon: Zap, mev: 35 },
  { name: 'Clean', blurb: 'Balanced scenario', icon: CircleGauge, mev: 46 },
  { name: 'Full', blurb: 'Detailed scenario', icon: Shield, mev: 78 },
  { name: 'Custom', blurb: 'Manual inputs', icon: Settings, mev: 55 },
];

function Help() {
  return (
    <CircleHelp className="inline size-3 text-[#697083]" aria-hidden="true" />
  );
}
function FieldLabel({
  children,
  optional,
  note,
}: {
  children: React.ReactNode;
  optional?: boolean;
  note?: string;
}) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[#eaebf0]">
      {children}
      {optional && (
        <span className="font-normal text-[#72788a]">(optional)</span>
      )}
      {note && <span className="font-normal text-[#72788a]">{note}</span>}
      <Help />
    </div>
  );
}
function Meter({
  value,
  left,
  right,
}: {
  value: number;
  left: string;
  right: string;
}) {
  return (
    <div>
      <div className="h-[3px] overflow-hidden rounded-full bg-[#2b2d36]">
        <div className="h-full bg-[#7a77ff]" style={{ width: `${value}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-[#72788a]">
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}

type PulseProps = {
  strategy: Strategy;
  setStrategy: (value: Strategy) => void;
  agents: number;
  setAgents: (value: number) => void;
  budget: number;
  setBudget: (value: number) => void;
  cadence: number;
  setCadence: (value: number) => void;
  orderSize: number;
  setOrderSize: (value: number) => void;
  spread: number;
  setSpread: (value: number) => void;
  inventory: number;
  setInventory: (value: number) => void;
  simulated: boolean;
  setSimulated: (value: boolean) => void;
  running: boolean;
  setRunning: (value: boolean) => void;
  plan: {
    orders: number;
    turnover: string;
    runway: string;
    risk: number;
    fees: string;
    utilization: number;
  };
};

type RpcNetworkStatus = {
  network: string;
  status: string;
  slot?: number;
  latencyMs?: number;
  error?: string;
};
type BackendCycle = {
  id: string;
  slot: number;
  blockhash: string;
  rpcLatencyMs: number;
  plannedOrders: number;
  projectedTurnover: number;
  riskScore: number;
  status: string;
  createdAt: string;
};
type SavedStrategy = {
  strategy?: Strategy;
  agents?: number;
  budget?: number;
  cadence?: number;
  orderSize?: number;
  spread?: number;
  inventory?: number;
};

function PulseBackendControls(props: PulseProps) {
  const [networks, setNetworks] = useState<RpcNetworkStatus[]>([]);
  const [cycles, setCycles] = useState<BackendCycle[]>([]);
  const [state, setState] = useState<
    'loading' | 'ready' | 'working' | 'auth' | 'error'
  >('loading');
  const [message, setMessage] = useState(
    'Connecting to Bundle Tek control plane…',
  );

  const payload = () => ({
    strategy: props.strategy,
    agents: props.agents,
    budget: props.budget,
    cadence: props.cadence,
    orderSize: props.orderSize,
    spread: props.spread,
    inventory: props.inventory,
  });

  const {
    setAgents,
    setBudget,
    setCadence,
    setInventory,
    setOrderSize,
    setSpread,
    setStrategy,
  } = props;

  const loadBackend = useCallback(async () => {
    try {
      const statusResponse = await fetch('/api/pulse/status', {
        cache: 'no-store',
      });
      const status = (await statusResponse.json()) as {
        networks?: RpcNetworkStatus[];
      };
      setNetworks(status.networks ?? []);
      const strategyResponse = await fetch('/api/pulse/strategy', {
        cache: 'no-store',
      });
      if (strategyResponse.status === 401) {
        setState('auth');
        setMessage('Sign in to save strategies and run backend cycles.');
        return;
      }
      if (!strategyResponse.ok) throw new Error('Strategy service unavailable');
      const saved = (await strategyResponse.json()) as {
        strategy?: SavedStrategy | null;
      };
      if (saved.strategy) {
        const strategy = saved.strategy;
        if (strategy.strategy) setStrategy(strategy.strategy);
        if (strategy.agents) setAgents(Number(strategy.agents));
        if (strategy.budget) setBudget(Number(strategy.budget));
        if (strategy.cadence) setCadence(Number(strategy.cadence));
        if (strategy.orderSize) setOrderSize(Number(strategy.orderSize));
        if (strategy.spread) setSpread(Number(strategy.spread));
        if (strategy.inventory) setInventory(Number(strategy.inventory));
      }
      const cyclesResponse = await fetch('/api/pulse/cycles', {
        cache: 'no-store',
      });
      if (cyclesResponse.ok)
        setCycles(
          ((await cyclesResponse.json()) as { cycles: BackendCycle[] }).cycles,
        );
      setState('ready');
      setMessage(
        saved.strategy
          ? 'Saved strategy loaded from D1.'
          : 'Backend online. Save this strategy to begin.',
      );
    } catch (error) {
      setState('error');
      setMessage(
        error instanceof Error ? error.message : 'Backend unavailable',
      );
    }
  }, [
    setAgents,
    setBudget,
    setCadence,
    setInventory,
    setOrderSize,
    setSpread,
    setStrategy,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => void loadBackend(), 0);
    return () => clearTimeout(timer);
  }, [loadBackend]);

  const saveStrategy = async () => {
    setState('working');
    setMessage('Saving strategy…');
    const response = await fetch('/api/pulse/strategy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload()),
    });
    if (response.status === 401) {
      setState('auth');
      setMessage('Sign in to control the backend.');
      return false;
    }
    const result = (await response.json()) as { error?: string };
    if (!response.ok) {
      setState('error');
      setMessage(result.error ?? 'Save failed');
      return false;
    }
    setState('ready');
    setMessage('Strategy persisted to D1.');
    return true;
  };

  const runCycle = async () => {
    const saved = await saveStrategy();
    if (!saved) return;
    setState('working');
    props.setRunning(true);
    setMessage(
      'Reading a live Solana slot and building a read-only shadow cycle…',
    );
    const response = await fetch('/api/pulse/cycles', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    const result = (await response.json()) as {
      cycle?: BackendCycle;
      error?: string;
    };
    props.setRunning(false);
    if (!response.ok || !result.cycle) {
      setState('error');
      setMessage(result.error ?? 'Cycle failed');
      return;
    }
    setCycles((current) => [result.cycle!, ...current].slice(0, 12));
    setState('ready');
    setMessage(
      `Read-only cycle recorded at slot ${result.cycle.slot.toLocaleString()}. No transaction submitted.`,
    );
  };

  return (
    <section className="backend-console">
      <div className="backend-heading">
        <span>
          <Database /> Backend control plane
        </span>
        <b className={`backend-state ${state}`}>{state.toUpperCase()}</b>
      </div>
      <div className="rpc-grid">
        {networks.map((network) => (
          <div key={network.network}>
            <span
              className={
                network.status === 'online' ? 'rpc-dot online' : 'rpc-dot'
              }
            />
            <span>
              <strong>{network.network}</strong>
              <small>
                {network.slot
                  ? `slot ${network.slot.toLocaleString()}`
                  : (network.error ?? 'checking')}
              </small>
            </span>
            <em>{network.latencyMs ? `${network.latencyMs}ms` : '—'}</em>
          </div>
        ))}
      </div>
      <p className="backend-message">{message}</p>
      {state === 'auth' ? (
        <Link className="backend-signin" href="/sign-in" target="_top">
          Sign in
        </Link>
      ) : (
        <div className="backend-actions">
          <Button
            variant="outline"
            onClick={() => void saveStrategy()}
            disabled={state === 'working'}
          >
            <Database /> Save strategy
          </Button>
          <Button
            className={`pulse-action ${props.running ? 'is-running' : ''}`}
            onClick={() => void runCycle()}
            disabled={state === 'working'}
          >
            {props.running ? (
              <>
                <RefreshCw className="animate-spin" /> Running live-data cycle
              </>
            ) : (
              <>
                <Play /> Run live-data cycle
              </>
            )}
          </Button>
        </div>
      )}
      {cycles.length > 0 && (
        <div className="cycle-log">
          <div className="cycle-log-title">
            <Activity /> Recent audit cycles
          </div>
          {cycles.slice(0, 3).map((cycle) => (
            <div className="cycle-row" key={cycle.id}>
              <span>
                <b>{cycle.status}</b>
                <small>slot {cycle.slot.toLocaleString()}</small>
              </span>
              <span>
                <b>{cycle.plannedOrders} plans/hr</b>
                <small>{cycle.projectedTurnover} SOL scenario</small>
              </span>
              <em>{cycle.rpcLatencyMs}ms</em>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PulseForm(props: PulseProps) {
  const strategies: Array<{
    name: Strategy;
    copy: string;
    icon: typeof Waves;
  }> = [
    { name: 'Balanced', copy: 'Two-sided inventory control', icon: Waves },
    {
      name: 'Liquidity',
      copy: 'Tighter, deeper quotes',
      icon: CircleDollarSign,
    },
    { name: 'Discovery', copy: 'Wider adaptive bands', icon: TrendingUp },
  ];
  return (
    <div className="settings-scroll pulse-scroll">
      <div className="page-title pulse-title">
        <span className="eyebrow">
          <Radio /> OUR TECH / PULSE ENGINE
        </span>
        <h1>Market Maker</h1>
        <p>
          Explore illustrative inventory and liquidity scenarios. No trading
          engine or execution adapter is connected.
        </p>
      </div>
      <div className="form-body">
        <div className="pulse-mode-tabs">
          {strategies.map(({ name, copy, icon: Icon }) => (
            <button
              key={name}
              onClick={() => props.setStrategy(name)}
              className={props.strategy === name ? 'active' : ''}
            >
              <Icon />
              <span>
                <strong>{name}</strong>
                <small>{copy}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="pulse-section-head">
          <span>
            <Bot /> Agent Fleet
          </span>
          <em>SIMULATION READY</em>
        </div>
        <div className="input-grid">
          <div>
            <FieldLabel note="(1-20)">Agents</FieldLabel>
            <Input
              value={props.agents}
              onChange={(e) =>
                props.setAgents(
                  Math.max(1, Math.min(20, Number(e.target.value))),
                )
              }
              type="number"
              min={1}
              max={20}
            />
          </div>
          <div>
            <FieldLabel>Budget per agent</FieldLabel>
            <div className="number-wrap">
              <Input
                value={props.budget}
                onChange={(e) => props.setBudget(Number(e.target.value))}
                type="number"
                min={0.5}
                step={0.5}
              />
              <span>◎</span>
            </div>
          </div>
        </div>
        <div className="control-card">
          <div className="control-row">
            <label>
              <TimerReset /> Quote cadence <b>{props.cadence}s</b>
            </label>
            <Slider
              value={[props.cadence]}
              onValueChange={(v) =>
                props.setCadence(typeof v === 'number' ? v : v[0])
              }
              min={5}
              max={180}
              step={5}
            />
          </div>
          <div className="control-row">
            <label>
              <SlidersHorizontal /> Maximum order{' '}
              <b>{props.orderSize.toFixed(2)} SOL</b>
            </label>
            <Slider
              value={[props.orderSize]}
              onValueChange={(v) =>
                props.setOrderSize(typeof v === 'number' ? v : v[0])
              }
              min={0.1}
              max={3}
              step={0.05}
            />
          </div>
          <div className="control-row">
            <label>
              <Waves /> Minimum spread <b>{props.spread} bps</b>
            </label>
            <Slider
              value={[props.spread]}
              onValueChange={(v) =>
                props.setSpread(typeof v === 'number' ? v : v[0])
              }
              min={20}
              max={300}
              step={5}
            />
          </div>
          <div className="control-row">
            <label>
              <CircleGauge /> Target base inventory <b>{props.inventory}%</b>
            </label>
            <Slider
              value={[props.inventory]}
              onValueChange={(v) =>
                props.setInventory(typeof v === 'number' ? v : v[0])
              }
              min={20}
              max={80}
              step={1}
            />
          </div>
        </div>
        <div className="safety-grid">
          <div>
            <Shield />
            <span>
              <strong>Self-trade prevention</strong>
              <small>Proposed wallet and route checks</small>
            </span>
            <b>PLANNED</b>
          </div>
          <div>
            <TriangleAlert />
            <span>
              <strong>Volatility brake</strong>
              <small>Modeled threshold: 8% / 5m</small>
            </span>
            <b>PLANNED</b>
          </div>
          <div>
            <Activity />
            <span>
              <strong>Organic throttle</strong>
              <small>Illustrative response to external flow</small>
            </span>
            <b>PLANNED</b>
          </div>
          <div>
            <Target />
            <span>
              <strong>Daily loss limit</strong>
              <small>Modeled limit: 8% of budget</small>
            </span>
            <b>PLANNED</b>
          </div>
        </div>
        <div className="simulation-row">
          <Checkbox
            checked
            disabled
            aria-label="Simulation only; execution unavailable"
          />
          <span>
            <strong>Simulation mode</strong>
            <small>
              No transactions are signed or submitted. Review the projected
              behavior before connecting execution.
            </small>
          </span>
        </div>
        <PulseBackendControls {...props} />
      </div>
    </div>
  );
}

function PulseInsights({
  strategy,
  agents,
  budget,
  cadence,
  orderSize,
  spread,
  inventory,
  running,
  plan,
}: PulseProps) {
  const ticks = [31, 45, 38, 57, 51, 67, 61, 74, 69, 82, 77, 89];
  return (
    <div className="insights-scroll pulse-insights">
      <section className="pulse-status">
        <div>
          <span className={running ? 'pulse-dot active' : 'pulse-dot'} />
          <div>
            <small>ENGINE STATE</small>
            <strong>{running ? 'READING DATA' : 'SCENARIO ONLY'}</strong>
          </div>
        </div>
        <em>PX-01</em>
      </section>
      <section className="pulse-chart">
        <div className="pulse-chart-head">
          <span>
            <BarChart3 /> Projected liquidity profile
          </span>
          <b>{strategy}</b>
        </div>
        <div className="mini-chart">
          {ticks.map((value, index) => (
            <i
              key={index}
              style={{ height: `${Math.min(96, value + agents)}%` }}
            />
          ))}
          <span className="midline" />
        </div>
        <div className="chart-labels">
          <span>Bid depth</span>
          <span>Mid</span>
          <span>Ask depth</span>
        </div>
      </section>
      <section className="pulse-kpis">
        <div>
          <small>Projected orders / hr</small>
          <strong>{plan.orders}</strong>
          <em>adaptive</em>
        </div>
        <div>
          <small>Capital deployed</small>
          <strong>{(agents * budget).toFixed(1)} SOL</strong>
          <em>{plan.utilization}% utilized</em>
        </div>
        <div>
          <small>Est. two-sided turnover</small>
          <strong>{plan.turnover} SOL</strong>
          <em>scenario only</em>
        </div>
        <div>
          <small>Budget runway</small>
          <strong>{plan.runway}</strong>
          <em>at current cadence</em>
        </div>
      </section>
      <section className="risk-map">
        <h2>
          <Shield /> Safety envelope{' '}
          <b>
            {plan.risk < 45
              ? 'CONSERVATIVE'
              : plan.risk < 70
                ? 'MODERATE'
                : 'AGGRESSIVE'}
          </b>
        </h2>
        <div className="risk-meter">
          <i style={{ width: `${plan.risk}%` }} />
        </div>
        <div className="risk-values">
          <span>
            Spread <b>{spread} bps</b>
          </span>
          <span>
            Order cap <b>{orderSize.toFixed(2)} SOL</b>
          </span>
          <span>
            Cadence <b>{cadence}s</b>
          </span>
          <span>
            Inventory{' '}
            <b>
              {inventory}/{100 - inventory}
            </b>
          </span>
        </div>
      </section>
      <section className="estimate-card pulse-estimate">
        <div className="est-row">
          <span>Scenario cost</span>
          <b>{plan.fees} SOL / day</b>
        </div>
        <div className="sub-row">
          <span>Self-trade checks</span>
          <b className="safe">NOT CONNECTED</b>
        </div>
        <div className="sub-row">
          <span>External execution</span>
          <b>NOT CONNECTED</b>
        </div>
        <div className="sub-row">
          <span>Mode</span>
          <b>SIMULATION ONLY</b>
        </div>
      </section>
      <div className="execution-note">
        <TriangleAlert />
        <p>
          <strong>Execution remains locked.</strong> Connecting wallets, signing
          trades, or activating a live strategy requires a separate reviewed
          integration and explicit approval.
        </p>
      </div>
    </div>
  );
}

export default function Home() {
  const revision = useRef(new DraftRevision());
  const [saveBusy, setSaveBusy] = useState(false);
  const [exploringRobinhood, setExploringRobinhood] = useState(false);
  const [robinhoodVenue, setRobinhoodVenue] = useState('hood.fun');
  const [view, setView] = useState<View>('dashboard');
  const [activityImportId, setActivityImportId] = useState('');
  const [activityWarmupId, setActivityWarmupId] = useState('');
  const [activityWithdrawalWallet, setActivityWithdrawalWallet] = useState('');
  const importedProjects = useImportedProjects();
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectVersion, setProjectVersion] = useState<string | null>(null);
  const [identity, setIdentity] = useState<TokenIdentity>(EMPTY_IDENTITY);
  const [venueOptions, setVenueOptions] = useState<VenueOptions>(
    DEFAULT_VENUE_OPTIONS,
  );
  const [projectSearch, setProjectSearch] = useState('');
  const [hasEdits, setHasEdits] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<
    (() => void) | null
  >(null);
  const [launchPlan, setLaunchPlan] =
    useState<LaunchPlanInput>(DEFAULT_LAUNCH_PLAN);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [persistenceState, setPersistenceState] = useState<
    'loading' | 'ready' | 'saving' | 'auth' | 'error'
  >('loading');
  const [planMessage, setPlanMessage] = useState('Loading saved launch plan…');
  const [runtimeStatus, setRuntimeStatus] = useState(
    'Checking mainnet RPC · Swap approval required',
  );
  const [advanced, setAdvanced] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const sidebarCollapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    readSidebarCollapsed,
    () => false,
  );
  const [planToolsOpen, setPlanToolsOpen] = useState(false);
  const [rpcLatency, setRpcLatency] = useState<number | null>(null);
  const [strategy, setStrategy] = useState<Strategy>('Balanced');
  const [agents, setAgents] = useState(6);
  const [budget, setBudget] = useState(4);
  const [cadence, setCadence] = useState(45);
  const [orderSize, setOrderSize] = useState(0.8);
  const [spread, setSpread] = useState(90);
  const [inventory, setInventory] = useState(50);
  const [simulated, setSimulated] = useState(true);
  const [running, setRunning] = useState(false);
  const updateLaunchPlan = (change: Partial<LaunchPlanInput>) => {
    revision.current.edit();
    setHasEdits(true);
    setLaunchPlan((current) => ({
      ...current,
      ...((change.chain !== undefined ||
        change.launchpad !== undefined ||
        change.currency !== undefined) &&
      !('quoteAddress' in change)
        ? { quoteAddress: undefined }
        : {}),
      ...change,
      holdersBuyQuote: holdersQuoteAfterPlanChange(current, change),
      mode: modeAfterVenueChange(current, change),
      developerBuy: developerBuyAfterPlanChange(
        current,
        change,
        modeAfterVenueChange(current, change),
      ),
      timing: timingAfterPlanChange(
        current,
        change,
        modeAfterVenueChange(current, change),
      ),
    }));
    setSavedAt(null);
    setPlanMessage('Unsaved launch-plan changes.');
    setPersistenceState((current) => (current === 'auth' ? 'auth' : 'ready'));
  };
  const updateIdentity = (change: Partial<TokenIdentity>) => {
    updateLaunchPlan({});
    setIdentity((current) => ({ ...current, ...change }));
  };
  const updateOptions = (change: Partial<VenueOptions>) => {
    updateLaunchPlan({});
    setVenueOptions((current) => ({ ...current, ...change }));
  };
  const {
    chain,
    launchpad,
    currency,
    tokenName,
    ticker,
    mode,
    preset,
    holderCount,
  } = launchPlan;
  const holdersUnit = holdersBuyUnit(launchPlan);
  const [setupOpen, setSetupOpen] = useState(false);
  const developer = launchPlan.developerBuy;
  const holders = launchPlan.holdersBuy;
  const mev = launchPlan.routingEmphasis;
  const scheduled = launchPlan.scheduled;
  const methodProfile = venueLaunchMethods(
    launchPlan.chain,
    launchPlan.launchpad,
  );
  const setMode = (value: Mode) => updateLaunchPlan({ mode: value });
  const setPreset = (value: Preset) => updateLaunchPlan({ preset: value });
  const setHolderCount = (value: number) =>
    updateLaunchPlan({ holderCount: value });
  const setMev = (value: number) =>
    updateLaunchPlan({ routingEmphasis: value });
  const planValidation = useMemo(() => {
    try {
      validateVenuePlan(launchPlan);
      validateSequencedSupply(launchPlan);
      validateHoldersQuoteAmount(launchPlan);
      validateQuoteSelection(launchPlan);
      validateLaunchMethod(launchPlan);
      validateLaunchTiming(launchPlan);
      validateLaunchWalletSelection(
        venueOptions.wallets,
        launchPlan.chain,
        launchPlan.holderCount,
      );
      return {
        plan: validateProjectDocument({
          plan: launchPlan,
          identity,
          options: venueOptions,
        }).plan,
        error: null as string | null,
      };
    } catch (error) {
      return {
        plan: null,
        error: error instanceof Error ? error.message : 'Invalid launch plan',
      };
    }
  }, [launchPlan, identity, venueOptions]);
  const figures = useMemo(
    () =>
      planValidation.plan
        ? deriveIllustrativeLaunchEstimate(planValidation.plan)
        : {
            allocation: 0,
            supplyCost: '0.00',
            walletReserve: '0.00',
            scenarioTotal: '0.00',
            maximumExposure: '0.00',
          },
    [planValidation.plan],
  );

  useEffect(() => {
    const timedStatusRequest = async () => {
      const requestStarted = performance.now();
      const response = await fetch('/api/pulse/status', { cache: 'no-store' });
      setRpcLatency(Math.round(performance.now() - requestStarted));
      return response;
    };
    const load = async () => {
      const started = revision.current.capture();
      try {
        const [planResponse, statusResponse, projectsResponse] =
          await Promise.all([
            fetch('/api/launch/plans', { cache: 'no-store' }),
            timedStatusRequest(),
            fetch('/api/projects', { cache: 'no-store' }),
          ]);
        if (statusResponse.ok) {
          const status = (await statusResponse.json()) as {
            networks?: RpcNetworkStatus[];
          };
          const mainnet = status.networks?.find(
            (network) => network.network === 'mainnet',
          );
          setRuntimeStatus(
            mainnet?.status === 'online'
              ? 'Mainnet RPC online · Swap approval required'
              : 'Mainnet RPC degraded · Swap approval required',
          );
        } else {
          setRuntimeStatus('Mainnet RPC unavailable · Swap approval required');
        }
        if (!revision.current.isCurrent(started)) return;
        if (projectsResponse.ok) {
          const data = (await projectsResponse.json()) as {
            projects: WorkspaceProject[];
          };
          setProjects(data.projects);
          if (data.projects.length) {
            setPersistenceState('ready');
            setPlanMessage(
              'Workspace loaded. Open a project or create a launch.',
            );
            return;
          }
        } else if (projectsResponse.status !== 401) {
          throw new Error(
            'Project library unavailable. Your existing saved plan is preserved.',
          );
        }
        if (planResponse.status === 401) {
          setPersistenceState('auth');
          setPlanMessage('Sign in to save and reload this plan.');
          return;
        }
        if (!planResponse.ok)
          throw new Error('Launch-plan service unavailable');
        const payload = (await planResponse.json()) as {
          plan: SavedLaunchPlan | null;
        };
        if (!revision.current.isCurrent(started)) return;
        if (payload.plan) {
          const { updatedAt: _updatedAt, ...plan } = payload.plan;
          setLaunchPlan(validateLaunchPlan(plan));
          setSavedAt(null);
          setPlanMessage(
            'Previous launch plan loaded. Save it to add it to your project library.',
          );
          setView('chain');
        } else {
          setPlanMessage('No saved plan yet. Configure and save this draft.');
        }
        setPersistenceState('ready');
      } catch (error) {
        if (!revision.current.isCurrent(started)) return;
        setPersistenceState('error');
        setPlanMessage(
          error instanceof Error
            ? error.message
            : 'Launch-plan service unavailable',
        );
        setRuntimeStatus('Mainnet RPC unavailable · Swap approval required');
      }
    };
    void load();
  }, []);

  const saveLaunchPlan = async () => {
    if (!revision.current.beginSave()) return;
    setSaveBusy(true);
    const started = revision.current.capture();
    try {
      const validated = validateProjectDocument({
        plan: launchPlan,
        identity,
        options: venueOptions,
      });
      setPersistenceState('saving');
      setPlanMessage('Saving validated launch plan…');
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...validated,
          id: projectId ?? crypto.randomUUID(),
          archived: false,
          expectedUpdatedAt: projectVersion,
        }),
      });
      if (response.status === 401) {
        setPersistenceState('auth');
        setPlanMessage('Sign in to save this plan.');
        return;
      }
      const payload = (await response.json()) as {
        project?: WorkspaceProject;
        error?: string;
      };
      if (!response.ok || !payload.project)
        throw new Error(payload.error ?? 'Plan save failed');
      const saved = payload.project;
      setProjects((current) => [
        saved,
        ...current.filter((p) => p.id !== saved.id),
      ]);
      setProjectId(saved.id);
      setProjectVersion(saved.updatedAt);
      if (!revision.current.isCurrent(started)) return;
      setLaunchPlan(saved.plan);
      setSavedAt(saved.updatedAt);
      setHasEdits(false);
      setPersistenceState('ready');
      setPlanMessage('Project saved to your workspace.');
    } catch (error) {
      if (!revision.current.isCurrent(started)) return;
      setPersistenceState('error');
      setPlanMessage(
        error instanceof Error ? error.message : 'Plan save failed',
      );
    } finally {
      revision.current.finishSave();
      setSaveBusy(false);
    }
  };
  const pulsePlan = useMemo(() => {
    const orders = Math.max(
      1,
      Math.round(
        (3600 / cadence) *
          agents *
          (strategy === 'Liquidity'
            ? 1.12
            : strategy === 'Discovery'
              ? 0.72
              : 0.9),
      ),
    );
    const turnover = (orders * orderSize * 0.58).toFixed(1);
    const burn = Math.max(0.01, orders * orderSize * 0.0018);
    const runwayHours =
      (agents * budget) / Math.max(0.01, orders * orderSize * 0.025);
    const risk = Math.min(
      94,
      Math.round((180 - cadence) / 3 + orderSize * 9 + (120 - spread) / 5),
    );
    return {
      orders,
      turnover,
      runway:
        runwayHours > 48
          ? `${Math.round(runwayHours / 24)}d`
          : `${Math.max(1, Math.round(runwayHours))}h`,
      risk: Math.max(12, risk),
      fees: (burn * 24).toFixed(2),
      utilization: Math.min(96, Math.round(35 + orderSize * 12 + agents * 2)),
    };
  }, [agents, budget, cadence, orderSize, spread, strategy]);
  const pulseProps: PulseProps = {
    strategy,
    setStrategy,
    agents,
    setAgents,
    budget,
    setBudget,
    cadence,
    setCadence,
    orderSize,
    setOrderSize,
    spread,
    setSpread,
    inventory,
    setInventory,
    simulated,
    setSimulated,
    running,
    setRunning,
    plan: pulsePlan,
  };
  const pickPreset = (name: Preset, presetMev: number) => {
    setPreset(name);
    setMev(presetMev);
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileNav(false);
        document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const toggleSidebar = () => writeSidebarCollapsed(!sidebarCollapsed);

  const changeView = (nextView: View) => {
    setExploringRobinhood(false);
    setView(nextView);
    setMobileNav(false);
  };

  const guardDraft = (action: () => void) => {
    if (saveBusy) return;
    if (hasEdits) setPendingNavigation(() => action);
    else action();
  };
  const startProject = () =>
    guardDraft(() => {
      revision.current.edit();
      setLaunchPlan({ ...DEFAULT_LAUNCH_PLAN });
      setIdentity({ ...EMPTY_IDENTITY });
      setVenueOptions({ ...DEFAULT_VENUE_OPTIONS });
      setProjectId(null);
      setProjectVersion(null);
      setSavedAt(null);
      setHasEdits(false);
      setPersistenceState('ready');
      setPlanMessage('New draft. Choose a chain and launchpad.');
      changeView('chain');
    });
  const startNarrativeProject = (draft: NarrativeDraft, keyword: string) =>
    guardDraft(() => {
      revision.current.edit();
      setLaunchPlan({
        ...DEFAULT_LAUNCH_PLAN,
        tokenName: draft.tokenName,
        ticker: draft.ticker,
        description: draft.description,
      });
      setIdentity({ ...EMPTY_IDENTITY });
      setVenueOptions({ ...DEFAULT_VENUE_OPTIONS });
      setProjectId(null);
      setProjectVersion(null);
      setSavedAt(null);
      setHasEdits(true);
      setPersistenceState('ready');
      setPlanMessage(
        `Draft from the "${keyword}" narrative. Choose a chain and launchpad, then review the token details.`,
      );
      changeView('chain');
    });
  const openProject = (project: WorkspaceProject, duplicate = false) =>
    guardDraft(() => {
      revision.current.edit();
      setLaunchPlan(project.plan);
      setIdentity(project.identity);
      setVenueOptions(project.options);
      setProjectId(duplicate ? null : project.id);
      setProjectVersion(duplicate ? null : project.updatedAt);
      setSavedAt(duplicate ? null : project.updatedAt);
      setHasEdits(duplicate);
      setPersistenceState('ready');
      setPlanMessage(
        duplicate
          ? 'Duplicate draft. Save to create a separate project.'
          : project.archived
            ? 'Archived project opened. Saving changes will restore it.'
            : 'Saved project opened.',
      );
      changeView('chain');
    });
  const reloadProjects = async () => {
    void importedProjects.refresh();
    try {
      const response = await fetch('/api/projects', { cache: 'no-store' });
      if (response.status === 401) {
        setPersistenceState('auth');
        setPlanMessage('Sign in to open your projects.');
        return;
      }
      if (!response.ok) throw new Error('Could not reload projects.');
      const data = (await response.json()) as { projects: WorkspaceProject[] };
      setProjects(data.projects);
      setPlanMessage('Project list refreshed.');
    } catch (error) {
      setPlanMessage(
        error instanceof Error ? error.message : 'Could not reload projects.',
      );
    }
  };
  const archiveProject = async (project: WorkspaceProject) => {
    if (saveBusy) return;
    setSaveBusy(true);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...project,
          archived: !project.archived,
          expectedUpdatedAt: project.updatedAt,
        }),
      });
      const result = (await response.json()) as {
        project?: WorkspaceProject;
        error?: string;
      };
      if (!response.ok || !result.project)
        throw new Error(result.error ?? 'Could not update archive.');
      const saved = result.project;
      setProjects((current) =>
        current.map((p) => (p.id === saved.id ? saved : p)),
      );
      if (projectId === saved.id) {
        setProjectVersion(saved.updatedAt);
        if (!hasEdits) setSavedAt(saved.updatedAt);
      }
      setPlanMessage(
        saved.archived
          ? 'Project archived. Restore it from Archived.'
          : 'Project restored.',
      );
    } catch (error) {
      setPlanMessage(
        error instanceof Error ? error.message : 'Could not update archive.',
      );
    } finally {
      setSaveBusy(false);
    }
  };
  const isLibrary = view === 'dashboard' || view === 'archived';
  const workspaceTitle = exploringRobinhood
    ? undefined
    : WORKSPACE_TITLES[view];
  const visibleProjects = projects.filter(
    (p) =>
      !p.archived &&
      `${p.plan.tokenName} ${p.plan.ticker}`
        .toLowerCase()
        .includes(projectSearch.toLowerCase()),
  );
  const visibleImports = importedProjects.projects.filter(
    (p) =>
      !p.archived &&
      `${p.document.token.name} ${p.document.token.symbol} ${p.document.token.chain} ${p.document.token.address}`
        .toLowerCase()
        .includes(projectSearch.trim().toLowerCase()),
  );
  const openImportedProject = (id: string) => {
    setActivityImportId(id);
    changeView('imports');
  };
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id === 'string') openImportedProject(id);
    };
    window.addEventListener(OPEN_IMPORTED_PROJECT_EVENT, open);
    return () => window.removeEventListener(OPEN_IMPORTED_PROJECT_EVENT, open);
  });
  const openSavedWarmup = (id: string) => {
    setActivityWithdrawalWallet('');
    setActivityWarmupId(id);
    changeView('wallets');
  };

  return (
    <div
      className={`app-shell ${isLibrary ? 'library-shell' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
    >
      <AlertDialog
        open={Boolean(pendingNavigation)}
        onOpenChange={(open) => {
          if (!open) setPendingNavigation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this unsaved draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Save your current changes before switching projects, or discard
              the unsaved edits.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingNavigation(null)}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = pendingNavigation;
                setPendingNavigation(null);
                action?.();
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <header className="topbar">
        <div className="brand-zone">
          <button
            className="mobile-menu"
            onClick={() => setMobileNav(!mobileNav)}
            aria-label="Toggle navigation"
            aria-expanded={mobileNav}
            aria-controls="project-navigation"
          >
            <Menu />
          </button>
          <div className="brand-mark">
            <i />
            <i />
            <i />
            <i />
          </div>
          <strong>Bundle Tek</strong>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggleSidebar}
            aria-label={
              sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
            }
            aria-pressed={sidebarCollapsed}
            aria-controls="project-navigation"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
        </div>
        {workspaceTitle ? (
          <nav className="steps workspace-crumb" aria-label="Location">
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{workspaceTitle}</span>
          </nav>
        ) : (
          <nav className="steps" aria-label="Product sections">
            <button
              onClick={() => changeView('chain')}
              aria-current={view === 'chain' ? 'step' : undefined}
              className={view === 'chain' ? 'active' : ''}
            >
              CHAIN &amp; LAUNCHPAD
            </button>
            <button
              onClick={() => changeView('token')}
              aria-current={view === 'token' ? 'step' : undefined}
              className={view === 'token' ? 'active' : ''}
            >
              TOKEN DETAILS
            </button>
            <button
              onClick={() => changeView('launch')}
              aria-current={view === 'launch' ? 'step' : undefined}
              className={view === 'launch' ? 'active' : ''}
            >
              LAUNCH SETTINGS
            </button>
          </nav>
        )}
        <div className="token-zone">
          <div className="token-avatar">
            {ticker.slice(0, 2) || 'PF'}
            <span />
          </div>
          <div>
            <strong>
              ${ticker || 'TOKEN'} <small>{tokenName || 'Untitled'}</small>
            </strong>
            <p>
              {exploringRobinhood
                ? `Robinhood · ${robinhoodVenue} · Planning only`
                : `${chain} · ${launchpad} · ${currency}`}
            </p>
          </div>
          {workspaceTitle ? (
            <Button
              variant="outline"
              className="archive-button"
              onClick={() => changeView('chain')}
              disabled={saveBusy}
            >
              <Rocket /> Open draft
            </Button>
          ) : (
            <Button
              variant="outline"
              className="archive-button"
              onClick={() => void saveLaunchPlan()}
              disabled={
                isLibrary ||
                view === 'watchlist' ||
                view === 'activity' ||
                view === 'imports' ||
                exploringRobinhood ||
                saveBusy ||
                persistenceState === 'loading' ||
                persistenceState === 'saving' ||
                Boolean(planValidation.error)
              }
            >
              <Database />{' '}
              {persistenceState === 'saving'
                ? 'Saving'
                : savedAt
                  ? 'Saved'
                  : 'Save plan'}
            </Button>
          )}
        </div>
      </header>

      {mobileNav && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside
        id="project-navigation"
        className={`sidebar ${mobileNav ? 'open' : ''}`}
        aria-label="Project navigation"
      >
        <div className="sidebar-search">
          <Search />
          <Input
            aria-label="Search saved projects"
            placeholder="Search projects"
            value={projectSearch}
            onChange={(e) => setProjectSearch(e.target.value)}
          />
        </div>
        <div className="sidebar-projects" aria-label="Saved projects">
          {visibleProjects.map((project) => (
            <button
              key={project.id}
              className={
                projectId === project.id && !isLibrary ? 'selected' : ''
              }
              onClick={() => openProject(project)}
              disabled={saveBusy}
            >
              <span className="project-avatar">
                {project.plan.ticker.slice(0, 2)}
              </span>
              <span>
                <strong>${project.plan.ticker}</strong>
                <small>{project.plan.tokenName}</small>
              </span>
              <em>Draft</em>
              <VenueMark name={project.plan.launchpad} size={16} />
            </button>
          ))}
          {visibleImports.map((project) => (
            <button
              key={`import:${project.id}`}
              aria-label={`Open imported ${project.document.token.name} from sidebar`}
              className={
                view === 'imports' && activityImportId === project.id
                  ? 'selected'
                  : ''
              }
              onClick={() => openImportedProject(project.id)}
              disabled={saveBusy}
            >
              <span className="project-avatar">
                {project.document.token.symbol.slice(0, 2)}
              </span>
              <span>
                <strong>${project.document.token.symbol}</strong>
                <small>{project.document.token.name}</small>
              </span>
              <em>Import</em>
              <VenueMark name={project.document.token.chain} size={16} />
            </button>
          ))}
          {importedProjects.error && (
            <p role="alert">{importedProjects.error}</p>
          )}
          {visibleProjects.length === 0 && visibleImports.length === 0 && (
            <p>
              {projectSearch
                ? 'No matching projects.'
                : importedProjects.loading
                  ? 'Loading saved imports…'
                  : 'Your saved projects appear here.'}
            </p>
          )}
        </div>
        <nav className="sidebar-section" aria-label="Features">
          <p>Features</p>
          <button
            onClick={() => {
              setActivityWarmupId('');
              setActivityWithdrawalWallet('');
              changeView('wallets');
            }}
            className={view === 'wallets' ? 'feature-active' : ''}
            aria-current={view === 'wallets' ? 'page' : undefined}
            title="My wallets"
          >
            <WalletCards /> <span className="nav-label">My wallets</span>
          </button>
          <button
            disabled={saveBusy}
            onClick={() =>
              guardDraft(() => window.location.assign('/marketplace'))
            }
            title="Marketplace"
          >
            <ShoppingCart /> <span className="nav-label">Marketplace</span>
            <b>PREVIEW</b>
          </button>
          <button
            onClick={() => changeView('tracker')}
            className={view === 'tracker' ? 'feature-active' : ''}
            aria-current={view === 'tracker' ? 'page' : undefined}
            title="Supply tracker"
          >
            <Crosshair /> <span className="nav-label">Supply tracker</span>
          </button>
          <button
            onClick={() => changeView('watchlist')}
            className={view === 'watchlist' ? 'feature-active' : ''}
            aria-current={view === 'watchlist' ? 'page' : undefined}
            title="Wallet tracker"
          >
            <Users /> <span className="nav-label">Wallet tracker</span>
            <b>NEW</b>
          </button>
          <button
            onClick={() => changeView('archived')}
            className={view === 'archived' ? 'feature-active' : ''}
            aria-current={view === 'archived' ? 'page' : undefined}
            title="Archived"
          >
            <Archive /> <span className="nav-label">Archived</span>
          </button>
          <button
            aria-current={view === 'dashboard' ? 'page' : undefined}
            onClick={() => changeView('dashboard')}
            className={view === 'dashboard' ? 'feature-active' : ''}
            title="Dashboard"
          >
            <LayoutDashboard /> <span className="nav-label">Dashboard</span>
          </button>
          <button
            onClick={() => changeView('activity')}
            className={view === 'activity' ? 'feature-active' : ''}
            aria-current={view === 'activity' ? 'page' : undefined}
            title="Activity"
          >
            <Activity /> <span className="nav-label">Activity</span>
          </button>
          <button
            onClick={() => {
              changeView('chain');
              setExploringRobinhood(true);
            }}
            className={exploringRobinhood ? 'feature-active' : ''}
            title="Robinhood research"
          >
            <Search /> <span className="nav-label">Robinhood research</span>
          </button>
        </nav>
        <nav
          className="sidebar-section planning-navigation"
          aria-label="Plan tools"
        >
          <button
            type="button"
            className="sidebar-group-toggle"
            aria-expanded={planToolsOpen || PLAN_TOOL_VIEWS.includes(view)}
            aria-controls="plan-tools-list"
            onClick={() => setPlanToolsOpen((open) => !open)}
            title="Plan tools"
          >
            <span className="nav-label">Plan tools</span>
            <ChevronDown />
          </button>
          {(planToolsOpen || PLAN_TOOL_VIEWS.includes(view)) && (
            <div id="plan-tools-list" className="sidebar-group-list">
              {(
                [
                  ['funding', Landmark, 'Funding review'],
                  ['distribution', Boxes, 'Devnet distribution'],
                  ['live', Activity, 'Operations preview'],
                  ['pulse', Bot, 'Pulse simulation'],
                ] as const
              ).map(([target, Icon, label]) => (
                <button
                  key={target}
                  className={view === target ? 'feature-active' : ''}
                  aria-current={view === target ? 'page' : undefined}
                  onClick={() => changeView(target)}
                  title={label}
                >
                  <Icon />
                  <span className="nav-label">{label}</span>
                </button>
              ))}
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <SidebarFunder
            chain={chain}
            onOpenWallets={() => changeView('wallets')}
          />
          <Button
            variant="outline"
            className="sidebar-import"
            onClick={() => {
              setActivityImportId('');
              changeView('imports');
            }}
            disabled={saveBusy}
            title="Import token"
          >
            <Download /> <span className="nav-label">Import</span>
          </Button>
          <Button
            className="sidebar-create"
            onClick={startProject}
            disabled={saveBusy}
            title="Create launch"
          >
            <Rocket /> <span className="nav-label">Create launch</span>
          </Button>
        </div>
      </aside>

      <main
        className={`workspace ${!exploringRobinhood && (isLibrary || view === 'wallets' || view === 'tracker' || view === 'watchlist' || view === 'activity' || view === 'imports' || view === 'distribution') ? 'tracker-workspace' : ''} ${!exploringRobinhood && (view === 'chain' || view === 'token') ? 'creation-workspace' : ''}`}
      >
        {exploringRobinhood ? (
          <RobinhoodPlanner
            venue={robinhoodVenue}
            onSelect={setRobinhoodVenue}
            onBack={() => {
              setExploringRobinhood(false);
              setView('chain');
            }}
          />
        ) : isLibrary ? (
          <>
            <ProjectDashboard
              projects={projects}
              archived={view === 'archived'}
              loading={persistenceState === 'loading'}
              busy={saveBusy}
              onOpen={openProject}
              onNew={startProject}
              onNarrativeDraft={startNarrativeProject}
              onDuplicate={(p) => openProject(p, true)}
              onArchive={(p) => void archiveProject(p)}
              onReload={() => void reloadProjects()}
              onImport={() => {
                setActivityImportId('');
                changeView('imports');
              }}
              onWallet={() => {
                setActivityWarmupId('');
                setActivityWithdrawalWallet('');
                changeView('wallets');
              }}
              imports={importedProjects.projects}
              importsLoading={importedProjects.loading}
              importsError={importedProjects.error}
              onOpenImport={openImportedProject}
              signedOut={persistenceState === 'auth'}
            />
            {persistenceState !== 'auth' && <SharedProjectsPanel />}
          </>
        ) : view === 'wallets' ? (
          <WalletWorkspace
            key={activityWarmupId + '/' + activityWithdrawalWallet}
            initialWarmupId={activityWarmupId}
            initialWithdrawalWallet={activityWithdrawalWallet}
            onFunding={() => changeView('funding')}
          />
        ) : view === 'tracker' ? (
          <SupplyTracker />
        ) : view === 'watchlist' ? (
          <WalletTracker onSupply={() => changeView('tracker')} />
        ) : view === 'imports' ? (
          <ImportedTokenProjects
            key={activityImportId}
            initialId={activityImportId}
            onProjectsChange={importedProjects.accept}
          />
        ) : view === 'activity' ? (
          <WorkspaceActivity
            projects={projects}
            onOpen={openProject}
            onOpenImport={openImportedProject}
            onOpenWarmup={openSavedWarmup}
            onOpenWithdrawal={(wallet) => {
              setActivityWarmupId('');
              setActivityWithdrawalWallet(wallet);
              changeView('wallets');
            }}
          />
        ) : view === 'distribution' ? (
          canUseDevnetTools(chain) ? (
            <DistributionWorkbench />
          ) : (
            <section className="settings-panel">
              <div className="page-title">
                <span className="eyebrow">SOLANA DEVNET ONLY</span>
                <h1>Distribution unavailable</h1>
                <p>
                  {chain} has no verified wallet or distribution integration.
                  Your plan remains a draft.
                </p>
                <Button
                  className="flow-next"
                  onClick={() => changeView('chain')}
                >
                  Review chain selection
                </Button>
              </div>
            </section>
          )
        ) : (
          <>
            <section className="settings-panel">
              {view === 'chain' ? (
                <ChainLaunchForm
                  validationError={planValidation.error}
                  options={venueOptions}
                  onOptionsChange={updateOptions}
                  onExploreRobinhood={() => {
                    setRobinhoodVenue(launchpad);
                    setExploringRobinhood(true);
                  }}
                  plan={launchPlan}
                  onChange={updateLaunchPlan}
                  onNext={() => setView('token')}
                />
              ) : view === 'token' ? (
                <PumpTokenWorkspaceNavigation
                  onOpen={(project) =>
                    guardDraft(() => {
                      importedProjects.accept([project]);
                      openImportedProject(project.id);
                    })
                  }
                >
                  <TokenDetailsForm
                    key={projectId ?? 'new-project'}
                    validationError={planValidation.error}
                    metadataProject={
                      projectId &&
                      projectVersion &&
                      !hasEdits &&
                      !saveBusy &&
                      persistenceState === 'ready' &&
                      projects.some(
                        (project) =>
                          project.id === projectId && !project.archived,
                      )
                        ? {
                            id: projectId,
                            updatedAt: projectVersion,
                            document: {
                              plan: launchPlan,
                              identity,
                              options: venueOptions,
                            },
                            payer: venueOptions.wallets?.deployer
                              ? {
                                  address:
                                    venueOptions.wallets.deployer.address,
                                  revision:
                                    venueOptions.wallets.deployer.revision,
                                }
                              : undefined,
                          }
                        : null
                    }
                    onSave={() => void saveLaunchPlan()}
                    saving={saveBusy}
                    identity={identity}
                    onIdentityChange={updateIdentity}
                    plan={launchPlan}
                    onChange={updateLaunchPlan}
                    onNext={() => setView('launch')}
                  />
                  {projectId &&
                    persistenceState === 'ready' &&
                    projects.some((p) => p.id === projectId) && (
                      <ProjectSharePanel
                        key={projectId}
                        projectId={projectId}
                      />
                    )}
                </PumpTokenWorkspaceNavigation>
              ) : view === 'funding' ? (
                <FundingForm
                  plan={launchPlan}
                  launchWallets={venueOptions.wallets}
                  estimate={figures}
                  validationError={planValidation.error}
                  onChange={updateLaunchPlan}
                  onNext={() => setView('distribution')}
                />
              ) : view === 'live' ? (
                <LiveOperationsForm
                  plan={launchPlan}
                  onOpenSimulation={() => setView('pulse')}
                />
              ) : view === 'launch' ? (
                <div className="settings-scroll launch-ws">
                  <header className="launch-ws-head">
                    <div className="launch-ws-token">
                      <span className="token-avatar">
                        {ticker.slice(0, 2) || 'PF'}
                      </span>
                      <span>
                        <strong>${ticker || 'TOKEN'}</strong>
                        <small>{tokenName || 'Untitled'}</small>
                      </span>
                    </div>
                    <dl className="launch-ws-tiles">
                      <div>
                        <dt>Supply buy</dt>
                        <dd>
                          {figures.allocation === null
                            ? '—'
                            : `${figures.allocation}%`}
                        </dd>
                      </div>
                      <div>
                        <dt>Holders</dt>
                        <dd>{holderCount}</dd>
                      </div>
                      <div>
                        <dt>Est. funding ({currency})</dt>
                        <dd>{figures.scenarioTotal}</dd>
                      </div>
                    </dl>
                  </header>
                  <LaunchWorkspacePanels
                    chain={chain}
                    onFund={() => changeView('funding')}
                    onOpenWallets={() => changeView('wallets')}
                  />
                  <h1 className="sr-only">Launch Settings</h1>
                  <p className="launch-ws-note">
                    Model allocations and compare scenarios. Nothing here
                    submits a launch or schedules a trade.
                  </p>
                  <div className="form-body launch-ws-body">
                    <div className="mode-tabs">
                      {methodProfile.methods.map((name) => {
                        const Icon =
                          name === 'Manual'
                            ? Hand
                            : name === 'Stagger'
                              ? Leaf
                              : name === 'Quick'
                                ? Zap
                                : CircleGauge;
                        return (
                          <button
                            key={name}
                            aria-pressed={mode === name}
                            onClick={() => setMode(name)}
                            className={mode === name ? 'active' : ''}
                          >
                            <Icon /> {launchModeLabel(name)} Mode
                          </button>
                        );
                      })}
                    </div>
                    {!methodProfile.methods.includes(mode) && (
                      <p role="alert" className="draft-error">
                        This saved draft uses {launchModeLabel(mode)}. Select an
                        available method before saving plan changes.
                      </p>
                    )}
                    <p className="source-note">
                      {methodProfile.captured
                        ? `Available planning methods for ${launchPlan.launchpad}.`
                        : 'Launch methods for this venue are unverified. Only a manual review draft is available.'}{' '}
                      Saving does not submit transactions or schedule trades.
                    </p>
                    <LaunchTimingForm
                      plan={launchPlan}
                      onChange={updateLaunchPlan}
                    />
                    {planValidation.error && (
                      <p role="alert" className="draft-error">
                        {planValidation.error}
                      </p>
                    )}
                    <LaunchBuyForm
                      plan={launchPlan}
                      onChange={updateLaunchPlan}
                    />
                    <div className="mt-4">
                      <FieldLabel
                        note={`(1-${venueLimits(chain, launchpad).maxRecipients})`}
                      >
                        <Users className="size-3.5 text-[#43efc1]" />
                        Holders Count
                      </FieldLabel>
                      <Input
                        aria-label="Holders Count"
                        value={holderCount}
                        onChange={(e) => setHolderCount(Number(e.target.value))}
                        type="number"
                        min={1}
                        max={venueLimits(chain, launchpad).maxRecipients}
                      />
                    </div>
                    <HolderDistributionForm
                      plan={launchPlan}
                      selection={venueOptions.wallets}
                      onChange={updateLaunchPlan}
                    />
                    <div className="section-label">
                      <Boxes /> Scenario preset
                    </div>
                    <div className="preset-grid">
                      {presets.map(
                        ({ name, blurb, icon: Icon, mev: presetMev }) => (
                          <button
                            key={name}
                            onClick={() => pickPreset(name, presetMev)}
                            className={preset === name ? 'active' : ''}
                          >
                            <span>
                              <Icon />
                              {name} <b>Build</b>
                            </span>
                            <small>{blurb}</small>
                          </button>
                        ),
                      )}
                    </div>
                    <div className="section-label">
                      <Crosshair /> Scenario routing emphasis
                    </div>
                    <Slider
                      aria-label="Scenario routing emphasis"
                      value={[mev]}
                      onValueChange={(v) => {
                        setMev(typeof v === 'number' ? v : v[0]);
                        setPreset('Custom');
                      }}
                      min={0}
                      max={100}
                      step={1}
                      className="mev-slider"
                    />
                    <div className="range-labels">
                      <span>Earlier stages</span>
                      <span>Distributed stages</span>
                    </div>
                    <LaunchWalletPicker
                      key={`${projectId ?? 'new'}/${launchPlan.chain}`}
                      plan={launchPlan}
                      selection={venueOptions.wallets}
                      onChange={(wallets) => updateOptions({ wallets })}
                      onOpenWallets={() => setView('wallets')}
                    />
                    <button
                      className="advanced-toggle"
                      onClick={() => setAdvanced(!advanced)}
                    >
                      <Settings /> ADVANCED INTEGRATION PARAMETERS · LOCKED
                      <i />
                      <ChevronDown className={advanced ? 'rotate' : ''} />
                    </button>
                    {advanced && (
                      <fieldset
                        disabled
                        className="advanced-grid"
                        aria-label="Advanced integration parameters are unavailable"
                      >
                        <div>
                          <FieldLabel optional note="(0-100)">
                            Slippage
                          </FieldLabel>
                          <div className="number-wrap">
                            <Input defaultValue="100" />
                            <span>%</span>
                          </div>
                        </div>
                        <div>
                          <FieldLabel optional>Funding Delay</FieldLabel>
                          <div className="delay">
                            <span>MIN</span>
                            <b>:</b>
                            <span>SEC</span>
                          </div>
                        </div>
                        <div>
                          <FieldLabel optional note="(0-100)">
                            Alternative Routing
                          </FieldLabel>
                          <div className="number-wrap">
                            <Input placeholder="0" />
                            <span>%</span>
                          </div>
                        </div>
                        <div>
                          <FieldLabel optional note="(0-200)">
                            Empty Holders
                          </FieldLabel>
                          <Input defaultValue="0" />
                        </div>
                        <div className="wide">
                          <FieldLabel optional>Fee Target</FieldLabel>
                          <div className="number-wrap">
                            <Input defaultValue="0" />
                            <span className="sol">◎</span>
                          </div>
                        </div>
                      </fieldset>
                    )}
                    <div className="scheduled">
                      <span>
                        <strong>Scheduled simulation</strong>
                        <small>
                          Record the deployment and holder phases separately for
                          review. No transaction is scheduled.
                        </small>
                      </span>
                      <Switch
                        aria-label="Scheduled simulation"
                        checked={scheduled}
                        onCheckedChange={(value) =>
                          updateLaunchPlan({ scheduled: value })
                        }
                      />
                    </div>
                  </div>
                  <div className="launch-action-bar">
                    <Button
                      variant="outline"
                      disabled={saveBusy}
                      onClick={() => void saveLaunchPlan()}
                    >
                      Save plan
                    </Button>
                    <Button
                      className="create-main"
                      onClick={() => setSetupOpen(true)}
                    >
                      <Landmark /> Review funding plan
                    </Button>
                  </div>
                  <LaunchWalletTable
                    plan={launchPlan}
                    onOpenWallets={() => changeView('wallets')}
                  />
                  <LaunchSetupDialog
                    open={setupOpen}
                    plan={launchPlan}
                    modeLabel={`${launchModeLabel(mode)} Mode`}
                    estimate={figures}
                    onOpenChange={setSetupOpen}
                    onContinue={() => {
                      setSetupOpen(false);
                      changeView('funding');
                    }}
                  />
                </div>
              ) : (
                <PulseForm {...pulseProps} />
              )}
            </section>

            <aside className="insights">
              {view === 'chain' ||
              view === 'token' ||
              view === 'funding' ||
              view === 'live' ? (
                <PlanRail
                  plan={launchPlan}
                  savedAt={savedAt}
                  persistenceState={persistenceState}
                  validationError={planValidation.error}
                />
              ) : view === 'launch' ? (
                <div className="insights-scroll">
                  <section className="mode-summary">
                    <div className="summary-title">
                      <CircleGauge />
                      <strong>{launchModeLabel(mode)} Mode</strong>
                      <span>Planning model</span>
                    </div>
                    <p>
                      {mode === 'Block-0'
                        ? 'Models an ordered sequence for review. It does not guarantee same-slot or Block-0 inclusion.'
                        : mode === 'Stagger' || mode === 'Organic'
                          ? 'Records staggered buying for review. Pacing and transaction submission are not connected.'
                          : mode === 'Quick'
                            ? 'Records a quick launch method for this venue. Submission speed and transaction ordering are not verified.'
                            : 'Models funding allocations for manual review. No funds are distributed.'}
                    </p>
                    <div className="pros">
                      <span>+++ &nbsp; Deterministic planning</span>
                      <span>--- &nbsp; External flow remains</span>
                      <span>+++ &nbsp; Auditable stages</span>
                      <span>-- &nbsp; Higher complexity</span>
                      <span>+++ &nbsp; Explicit scenario roles</span>
                      <span>- &nbsp; Mainnet execution unavailable</span>
                    </div>
                  </section>
                  <section className="build-analysis">
                    <h2>
                      <Gauge /> {preset} Build <ChevronDown />
                    </h2>
                    <div className="metric-grid">
                      <div>
                        <div className="metric-label">
                          <Users /> Cluster outcome <Help />
                          <b>UNVERIFIED</b>
                        </div>
                        <Meter
                          value={mev + 12}
                          left="Unknown"
                          right="Needs live proof"
                        />
                      </div>
                      <div>
                        <div className="metric-label">
                          <CircleGauge /> Scenario cost <Help />
                          <b>{figures.supplyCost}</b>
                        </div>
                        {Number.isFinite(Number(figures.supplyCost)) ? (
                          <Meter
                            value={Math.min(94, Number(figures.supplyCost) * 9)}
                            left="Lower"
                            right="Higher"
                          />
                        ) : (
                          <p className="source-note">
                            No verified estimate for this network and method.
                          </p>
                        )}
                      </div>
                      <div>
                        <div className="metric-label">
                          <Target /> Routing emphasis <Help />
                        </div>
                        <Meter value={mev} left="Earlier" right="Distributed" />
                      </div>
                      <div>
                        <div className="metric-label">
                          <Activity /> Planned duration <Help />
                          <b>
                            {Math.round(64 - mev / 5)}m {Math.round(mev % 60)}s
                          </b>
                        </div>
                        <Meter
                          value={Math.min(96, holderCount / 2)}
                          left="Fastest"
                          right="Longest"
                        />
                      </div>
                    </div>
                  </section>
                  <section className="estimate-card">
                    <div className="est-row muted">
                      <span>
                        Estimate source <Help />
                      </span>
                      <b>
                        {planValidation.error
                          ? 'PLAN INVALID · ESTIMATES PAUSED'
                          : 'VALIDATED PLAN · NO LIVE QUOTE'}
                      </b>
                    </div>
                    <div className="est-row">
                      <span>
                        {holdersUnit === 'supply'
                          ? 'Supply allocation'
                          : 'Holders quote amount'}{' '}
                        <Help />
                      </span>
                      <b>
                        <strong>
                          {planValidation.error
                            ? '—'
                            : holdersUnit === 'supply'
                              ? `${figures.allocation}%`
                              : launchPlan.holdersBuyQuote !== undefined
                                ? `${launchPlan.holdersBuyQuote} ${currency}`
                                : '—'}
                        </strong>
                      </b>
                    </div>
                    <div className="sub-row">
                      <span>
                        Deployer <Help />
                      </span>
                      <b>{developer}%</b>
                    </div>
                    <div className="sub-row">
                      <span>
                        Holders <Help />
                      </span>
                      <b>
                        {holdersUnit === 'supply'
                          ? `${holders}%`
                          : launchPlan.holdersBuyQuote !== undefined
                            ? `${launchPlan.holdersBuyQuote} ${currency}`
                            : '—'}
                      </b>
                    </div>
                  </section>
                  <section className="estimate-card funding-card">
                    <div className="est-row">
                      <span>Illustrative funding scenario</span>
                      <b>
                        {figures.scenarioTotal}{' '}
                        {chain === 'Solana' ? 'SOL' : currency}
                      </b>
                    </div>
                    <div className="sub-row">
                      <span>
                        Allocation scenario <Help />
                      </span>
                      <b>{figures.supplyCost}</b>
                    </div>
                    <div className="sub-row">
                      <span>
                        Wallet reserve <Help />
                      </span>
                      <b>{figures.walletReserve}</b>
                    </div>
                    <div className="sub-row danger">
                      <span>
                        Maximum modeled exposure <Help />
                      </span>
                      <b>{figures.maximumExposure}</b>
                    </div>
                  </section>
                  <Button
                    className="create-side"
                    onClick={() => changeView('funding')}
                  >
                    <Landmark /> Review funding
                  </Button>
                </div>
              ) : (
                <PulseInsights {...pulseProps} />
              )}
            </aside>
          </>
        )}
      </main>
      <footer className="statusbar">
        <span className="live">
          <i />{' '}
          {exploringRobinhood
            ? 'Robinhood · Read-only research'
            : chain === 'Solana'
              ? `Solana · ${runtimeStatus}`
              : `${chain} · Planning only · Execution locked`}
          {rpcLatency !== null && (
            <span className="latency">
              {' · RPC '}
              {rpcLatency < 1000
                ? `${rpcLatency}ms`
                : `${(rpcLatency / 1000).toFixed(1)}s`}
            </span>
          )}
        </span>
        {workspaceTitle ? (
          <span className="plan-save-state" />
        ) : (
          <output
            title={planValidation.error ?? planMessage}
            className={`plan-save-state ${planValidation.error ? 'error' : persistenceState}`}
          >
            {planValidation.error ?? planMessage}
          </output>
        )}
        {persistenceState === 'auth' && (
          <Link href="/sign-in">Sign in to save</Link>
        )}
        <StatusPrices />
        <button
          type="button"
          className="statusbar-link"
          onClick={() => changeView('activity')}
        >
          <Activity /> Activity
        </button>
        <span className="network-boundary">
          DEVNET TOOLS · SWAP APPROVAL REQUIRED
        </span>
      </footer>
    </div>
  );
}
