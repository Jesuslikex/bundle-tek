'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity, Boxes, ChevronDown, CircleGauge, CircleHelp, Crosshair,
  Database, Gauge, Gem, Hand, Landmark, Leaf, Menu,
  PanelLeftClose, Pencil, Settings, Shield, Sparkles,
  BarChart3, Bot, CircleDollarSign, Play, Radio, RefreshCw, SlidersHorizontal,
  Target, TimerReset, TrendingUp, TriangleAlert, Users, WalletCards, Waves, Zap,
} from 'lucide-react';
import { DraftRevision } from '@/lib/draft-revision';
import { RobinhoodPlanner } from '@/components/launch/robinhood-planner';
import { canUseDevnetTools } from '@/lib/workspace-capabilities';
import { ChainLaunchForm } from '@/components/launch/chain-launch-form';
import { FundingForm } from '@/components/launch/funding-form';
import { LiveOperationsForm } from '@/components/launch/live-operations-form';
import { PlanRail } from '@/components/launch/plan-rail';
import { TokenDetailsForm } from '@/components/launch/token-details-form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { SupplyTracker } from '@/components/supply-tracker';
import { DistributionWorkbench } from '@/components/distribution-workbench';
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

type View = 'chain' | 'token' | 'launch' | 'funding' | 'distribution' | 'live' | 'pulse' | 'tracker';
type Strategy = 'Balanced' | 'Liquidity' | 'Discovery';
const presets: Array<{ name: Preset; blurb: string; icon: typeof Zap; mev: number }> = [
  { name: 'Quick', blurb: 'Simple scenario', icon: Zap, mev: 35 },
  { name: 'Clean', blurb: 'Balanced scenario', icon: CircleGauge, mev: 46 },
  { name: 'Full', blurb: 'Detailed scenario', icon: Shield, mev: 78 },
  { name: 'Custom', blurb: 'Manual inputs', icon: Settings, mev: 55 },
];

function Help() { return <CircleHelp className="inline size-3 text-[#697083]" aria-hidden="true" />; }
function FieldLabel({ children, optional, note }: { children: React.ReactNode; optional?: boolean; note?: string }) {
  return <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[#eaebf0]">{children}{optional && <span className="font-normal text-[#72788a]">(optional)</span>}{note && <span className="font-normal text-[#72788a]">{note}</span>}<Help /></div>;
}
function Meter({ value, left, right }: { value: number; left: string; right: string }) {
  return <div><div className="h-[3px] overflow-hidden rounded-full bg-[#2b2d36]"><div className="h-full bg-[#7a77ff]" style={{ width: `${value}%` }} /></div><div className="mt-2 flex justify-between text-[10px] text-[#72788a]"><span>{left}</span><span>{right}</span></div></div>;
}

type PulseProps = {
  strategy: Strategy; setStrategy: (value: Strategy) => void;
  agents: number; setAgents: (value: number) => void;
  budget: number; setBudget: (value: number) => void;
  cadence: number; setCadence: (value: number) => void;
  orderSize: number; setOrderSize: (value: number) => void;
  spread: number; setSpread: (value: number) => void;
  inventory: number; setInventory: (value: number) => void;
  simulated: boolean; setSimulated: (value: boolean) => void;
  running: boolean; setRunning: (value: boolean) => void;
  plan: { orders: number; turnover: string; runway: string; risk: number; fees: string; utilization: number };
};

type RpcNetworkStatus = { network: string; status: string; slot?: number; latencyMs?: number; error?: string };
type BackendCycle = { id: string; slot: number; blockhash: string; rpcLatencyMs: number; plannedOrders: number; projectedTurnover: number; riskScore: number; status: string; createdAt: string };
type SavedStrategy = { strategy?: Strategy; agents?: number; budget?: number; cadence?: number; orderSize?: number; spread?: number; inventory?: number };

function PulseBackendControls(props: PulseProps) {
  const [networks, setNetworks] = useState<RpcNetworkStatus[]>([]);
  const [cycles, setCycles] = useState<BackendCycle[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'working' | 'auth' | 'error'>('loading');
  const [message, setMessage] = useState('Connecting to PulseForge control plane…');

  const payload = () => ({ strategy: props.strategy, agents: props.agents, budget: props.budget, cadence: props.cadence, orderSize: props.orderSize, spread: props.spread, inventory: props.inventory });

  const { setAgents, setBudget, setCadence, setInventory, setOrderSize, setSpread, setStrategy } = props;

  const loadBackend = useCallback(async () => {
    try {
      const statusResponse = await fetch('/api/pulse/status', { cache: 'no-store' });
      const status = await statusResponse.json() as { networks?: RpcNetworkStatus[] };
      setNetworks(status.networks ?? []);
      const strategyResponse = await fetch('/api/pulse/strategy', { cache: 'no-store' });
      if (strategyResponse.status === 401) { setState('auth'); setMessage('Sign in to save strategies and run backend cycles.'); return; }
      if (!strategyResponse.ok) throw new Error('Strategy service unavailable');
      const saved = await strategyResponse.json() as { strategy?: SavedStrategy | null };
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
      const cyclesResponse = await fetch('/api/pulse/cycles', { cache: 'no-store' });
      if (cyclesResponse.ok) setCycles(((await cyclesResponse.json()) as { cycles: BackendCycle[] }).cycles);
      setState('ready'); setMessage(saved.strategy ? 'Saved strategy loaded from D1.' : 'Backend online. Save this strategy to begin.');
    } catch (error) {
      setState('error'); setMessage(error instanceof Error ? error.message : 'Backend unavailable');
    }
  }, [setAgents, setBudget, setCadence, setInventory, setOrderSize, setSpread, setStrategy]);

  useEffect(() => {
    const timer = setTimeout(() => void loadBackend(), 0);
    return () => clearTimeout(timer);
  }, [loadBackend]);

  const saveStrategy = async () => {
    setState('working'); setMessage('Saving strategy…');
    const response = await fetch('/api/pulse/strategy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()) });
    if (response.status === 401) { setState('auth'); setMessage('Sign in to control the backend.'); return false; }
    const result = await response.json() as { error?: string };
    if (!response.ok) { setState('error'); setMessage(result.error ?? 'Save failed'); return false; }
    setState('ready'); setMessage('Strategy persisted to D1.'); return true;
  };

  const runCycle = async () => {
    const saved = await saveStrategy();
    if (!saved) return;
    setState('working'); props.setRunning(true); setMessage('Reading a live Solana slot and building a read-only shadow cycle…');
    const response = await fetch('/api/pulse/cycles', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    const result = await response.json() as { cycle?: BackendCycle; error?: string };
    props.setRunning(false);
    if (!response.ok || !result.cycle) { setState('error'); setMessage(result.error ?? 'Cycle failed'); return; }
    setCycles((current) => [result.cycle!, ...current].slice(0, 12));
    setState('ready'); setMessage(`Read-only cycle recorded at slot ${result.cycle.slot.toLocaleString()}. No transaction submitted.`);
  };

  return <section className="backend-console">
    <div className="backend-heading"><span><Database /> Backend control plane</span><b className={`backend-state ${state}`}>{state.toUpperCase()}</b></div>
    <div className="rpc-grid">{networks.map((network) => <div key={network.network}><span className={network.status === 'online' ? 'rpc-dot online' : 'rpc-dot'} /><span><strong>{network.network}</strong><small>{network.slot ? `slot ${network.slot.toLocaleString()}` : network.error ?? 'checking'}</small></span><em>{network.latencyMs ? `${network.latencyMs}ms` : '—'}</em></div>)}</div>
    <p className="backend-message">{message}</p>
    {state === 'auth' ? <Link className="backend-signin" href="/signin-with-chatgpt?return_to=/" target="_top">Sign in with ChatGPT</Link> : <div className="backend-actions"><Button variant="outline" onClick={() => void saveStrategy()} disabled={state === 'working'}><Database /> Save strategy</Button><Button className={`pulse-action ${props.running ? 'is-running' : ''}`} onClick={() => void runCycle()} disabled={state === 'working'}>{props.running ? <><RefreshCw className="animate-spin" /> Running live-data cycle</> : <><Play /> Run live-data cycle</>}</Button></div>}
    {cycles.length > 0 && <div className="cycle-log"><div className="cycle-log-title"><Activity /> Recent audit cycles</div>{cycles.slice(0, 3).map((cycle) => <div className="cycle-row" key={cycle.id}><span><b>{cycle.status}</b><small>slot {cycle.slot.toLocaleString()}</small></span><span><b>{cycle.plannedOrders} plans/hr</b><small>{cycle.projectedTurnover} SOL scenario</small></span><em>{cycle.rpcLatencyMs}ms</em></div>)}</div>}
  </section>;
}

function PulseForm(props: PulseProps) {
  const strategies: Array<{ name: Strategy; copy: string; icon: typeof Waves }> = [
    { name: 'Balanced', copy: 'Two-sided inventory control', icon: Waves },
    { name: 'Liquidity', copy: 'Tighter, deeper quotes', icon: CircleDollarSign },
    { name: 'Discovery', copy: 'Wider adaptive bands', icon: TrendingUp },
  ];
  return <div className="settings-scroll pulse-scroll">
    <div className="page-title pulse-title"><span className="eyebrow"><Radio /> OUR TECH / PULSE ENGINE</span><h1>Market Maker</h1><p>Explore illustrative inventory and liquidity scenarios. No trading engine or execution adapter is connected.</p></div>
    <div className="form-body">
      <div className="pulse-mode-tabs">{strategies.map(({ name, copy, icon: Icon }) => <button key={name} onClick={() => props.setStrategy(name)} className={props.strategy === name ? 'active' : ''}><Icon /><span><strong>{name}</strong><small>{copy}</small></span></button>)}</div>
      <div className="pulse-section-head"><span><Bot /> Agent Fleet</span><em>SIMULATION READY</em></div>
      <div className="input-grid">
        <div><FieldLabel note="(1-20)">Agents</FieldLabel><Input value={props.agents} onChange={(e) => props.setAgents(Math.max(1, Math.min(20, Number(e.target.value))))} type="number" min={1} max={20} /></div>
        <div><FieldLabel>Budget per agent</FieldLabel><div className="number-wrap"><Input value={props.budget} onChange={(e) => props.setBudget(Number(e.target.value))} type="number" min={0.5} step={0.5} /><span>◎</span></div></div>
      </div>
      <div className="control-card">
        <div className="control-row"><label><TimerReset /> Quote cadence <b>{props.cadence}s</b></label><Slider value={[props.cadence]} onValueChange={(v) => props.setCadence(typeof v === 'number' ? v : v[0])} min={5} max={180} step={5} /></div>
        <div className="control-row"><label><SlidersHorizontal /> Maximum order <b>{props.orderSize.toFixed(2)} SOL</b></label><Slider value={[props.orderSize]} onValueChange={(v) => props.setOrderSize(typeof v === 'number' ? v : v[0])} min={0.1} max={3} step={0.05} /></div>
        <div className="control-row"><label><Waves /> Minimum spread <b>{props.spread} bps</b></label><Slider value={[props.spread]} onValueChange={(v) => props.setSpread(typeof v === 'number' ? v : v[0])} min={20} max={300} step={5} /></div>
        <div className="control-row"><label><CircleGauge /> Target base inventory <b>{props.inventory}%</b></label><Slider value={[props.inventory]} onValueChange={(v) => props.setInventory(typeof v === 'number' ? v : v[0])} min={20} max={80} step={1} /></div>
      </div>
      <div className="safety-grid"><div><Shield /><span><strong>Self-trade prevention</strong><small>Proposed wallet and route checks</small></span><b>PLANNED</b></div><div><TriangleAlert /><span><strong>Volatility brake</strong><small>Modeled threshold: 8% / 5m</small></span><b>PLANNED</b></div><div><Activity /><span><strong>Organic throttle</strong><small>Illustrative response to external flow</small></span><b>PLANNED</b></div><div><Target /><span><strong>Daily loss limit</strong><small>Modeled limit: 8% of budget</small></span><b>PLANNED</b></div></div>
      <div className="simulation-row"><Checkbox checked disabled aria-label="Simulation only; execution unavailable" /><span><strong>Simulation mode</strong><small>No transactions are signed or submitted. Review the projected behavior before connecting execution.</small></span></div>
      <PulseBackendControls {...props} />
    </div>
  </div>;
}

function PulseInsights({ strategy, agents, budget, cadence, orderSize, spread, inventory, running, plan }: PulseProps) {
  const ticks = [31, 45, 38, 57, 51, 67, 61, 74, 69, 82, 77, 89];
  return <div className="insights-scroll pulse-insights">
    <section className="pulse-status"><div><span className={running ? 'pulse-dot active' : 'pulse-dot'} /><div><small>ENGINE STATE</small><strong>{running ? 'READING DATA' : 'SCENARIO ONLY'}</strong></div></div><em>PX-01</em></section>
    <section className="pulse-chart"><div className="pulse-chart-head"><span><BarChart3 /> Projected liquidity profile</span><b>{strategy}</b></div><div className="mini-chart">{ticks.map((value, index) => <i key={index} style={{ height: `${Math.min(96, value + agents)}%` }} />)}<span className="midline" /></div><div className="chart-labels"><span>Bid depth</span><span>Mid</span><span>Ask depth</span></div></section>
    <section className="pulse-kpis"><div><small>Projected orders / hr</small><strong>{plan.orders}</strong><em>adaptive</em></div><div><small>Capital deployed</small><strong>{(agents * budget).toFixed(1)} SOL</strong><em>{plan.utilization}% utilized</em></div><div><small>Est. two-sided turnover</small><strong>{plan.turnover} SOL</strong><em>scenario only</em></div><div><small>Budget runway</small><strong>{plan.runway}</strong><em>at current cadence</em></div></section>
    <section className="risk-map"><h2><Shield /> Safety envelope <b>{plan.risk < 45 ? 'CONSERVATIVE' : plan.risk < 70 ? 'MODERATE' : 'AGGRESSIVE'}</b></h2><div className="risk-meter"><i style={{ width: `${plan.risk}%` }} /></div><div className="risk-values"><span>Spread <b>{spread} bps</b></span><span>Order cap <b>{orderSize.toFixed(2)} SOL</b></span><span>Cadence <b>{cadence}s</b></span><span>Inventory <b>{inventory}/{100 - inventory}</b></span></div></section>
    <section className="estimate-card pulse-estimate"><div className="est-row"><span>Scenario cost</span><b>{plan.fees} SOL / day</b></div><div className="sub-row"><span>Self-trade checks</span><b className="safe">NOT CONNECTED</b></div><div className="sub-row"><span>External execution</span><b>NOT CONNECTED</b></div><div className="sub-row"><span>Mode</span><b>SIMULATION ONLY</b></div></section>
    <div className="execution-note"><TriangleAlert /><p><strong>Execution remains locked.</strong> Connecting wallets, signing trades, or activating a live strategy requires a separate reviewed integration and explicit approval.</p></div>
  </div>;
}

export default function Home() {
  const revision = useRef(new DraftRevision());
  const [saveBusy, setSaveBusy] = useState(false);
  const [exploringRobinhood, setExploringRobinhood] = useState(false);
  const [robinhoodVenue, setRobinhoodVenue] = useState('hood.fun');
  const [view, setView] = useState<View>('chain');
  const [launchPlan, setLaunchPlan] = useState<LaunchPlanInput>(DEFAULT_LAUNCH_PLAN);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [persistenceState, setPersistenceState] = useState<'loading' | 'ready' | 'saving' | 'auth' | 'error'>('loading');
  const [planMessage, setPlanMessage] = useState('Loading saved launch plan…');
  const [runtimeStatus, setRuntimeStatus] = useState('Checking mainnet RPC · Execution locked');
  const [advanced, setAdvanced] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
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
    setLaunchPlan((current) => ({ ...current, ...change }));
    setSavedAt(null);
    setPlanMessage('Unsaved launch-plan changes.');
    setPersistenceState((current) => current === 'auth' ? 'auth' : 'ready');
  };
  const { chain, launchpad, currency, tokenName, ticker, mode, preset, holderCount } = launchPlan;
  const developer = launchPlan.developerBuy;
  const holders = launchPlan.holdersBuy;
  const mev = launchPlan.routingEmphasis;
  const scheduled = launchPlan.scheduled;
  const setMode = (value: Mode) => updateLaunchPlan({ mode: value });
  const setPreset = (value: Preset) => updateLaunchPlan({ preset: value });
  const setDeveloper = (value: number) => updateLaunchPlan({ developerBuy: value });
  const setHolders = (value: number) => updateLaunchPlan({ holdersBuy: value });
  const setHolderCount = (value: number) => updateLaunchPlan({ holderCount: value });
  const setMev = (value: number) => updateLaunchPlan({ routingEmphasis: value });
  const planValidation = useMemo(() => {
    try {
      return { plan: validateLaunchPlan(launchPlan), error: null as string | null };
    } catch (error) {
      return { plan: null, error: error instanceof Error ? error.message : 'Invalid launch plan' };
    }
  }, [launchPlan]);
  const figures = useMemo(() => planValidation.plan
    ? deriveIllustrativeLaunchEstimate(planValidation.plan)
    : { allocation: 0, supplyCost: '0.00', walletReserve: '0.00', scenarioTotal: '0.00', maximumExposure: '0.00' },
  [planValidation.plan]);

  useEffect(() => {
    const load = async () => {
      const started = revision.current.capture();
      try {
        const [planResponse, statusResponse] = await Promise.all([
          fetch('/api/launch/plans', { cache: 'no-store' }),
          fetch('/api/pulse/status', { cache: 'no-store' }),
        ]);
        if (statusResponse.ok) {
          const status = await statusResponse.json() as { networks?: RpcNetworkStatus[] };
          const mainnet = status.networks?.find((network) => network.network === 'mainnet');
          setRuntimeStatus(mainnet?.status === 'online' ? 'Mainnet RPC online · Execution locked' : 'Mainnet RPC degraded · Execution locked');
        } else {
          setRuntimeStatus('Mainnet RPC unavailable · Execution locked');
        }
        if (!revision.current.isCurrent(started)) return;
        if (planResponse.status === 401) {
          setPersistenceState('auth');
          setPlanMessage('Sign in with ChatGPT to save and reload this plan.');
          return;
        }
        if (!planResponse.ok) throw new Error('Launch-plan service unavailable');
        const payload = await planResponse.json() as { plan: SavedLaunchPlan | null };
        if (!revision.current.isCurrent(started)) return;
        if (payload.plan) {
          const { updatedAt, ...plan } = payload.plan;
          setLaunchPlan(validateLaunchPlan(plan));
          setSavedAt(updatedAt);
          setPlanMessage('Saved launch plan loaded from D1.');
        } else {
          setPlanMessage('No saved plan yet. Configure and save this draft.');
        }
        setPersistenceState('ready');
      } catch (error) {
        if (!revision.current.isCurrent(started)) return;
        setPersistenceState('error');
        setPlanMessage(error instanceof Error ? error.message : 'Launch-plan service unavailable');
        setRuntimeStatus('Mainnet RPC unavailable · Execution locked');
      }
    };
    void load();
  }, []);

  const saveLaunchPlan = async () => {
    if (!revision.current.beginSave()) return;
    setSaveBusy(true);
    const started = revision.current.capture();
    try {
      const validated = validateLaunchPlan(launchPlan);
      setPersistenceState('saving');
      setPlanMessage('Saving validated launch plan…');
      const response = await fetch('/api/launch/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validated),
      });
      if (!revision.current.isCurrent(started)) return;
      if (response.status === 401) {
        setPersistenceState('auth');
        setPlanMessage('Sign in with ChatGPT to save this plan.');
        return;
      }
      const payload = await response.json() as { plan?: SavedLaunchPlan; error?: string };
      if (!revision.current.isCurrent(started)) return;
      if (!response.ok || !payload.plan) throw new Error(payload.error ?? 'Plan save failed');
      setLaunchPlan(validateLaunchPlan(payload.plan));
      setSavedAt(payload.plan.updatedAt);
      setPersistenceState('ready');
      setPlanMessage('Validated launch plan saved to D1.');
    } catch (error) {
      if (!revision.current.isCurrent(started)) return;
      setPersistenceState('error');
      setPlanMessage(error instanceof Error ? error.message : 'Plan save failed');
    } finally { revision.current.finishSave(); setSaveBusy(false); }
  };
  const pulsePlan = useMemo(() => {
    const orders = Math.max(1, Math.round((3600 / cadence) * agents * (strategy === 'Liquidity' ? 1.12 : strategy === 'Discovery' ? 0.72 : 0.9)));
    const turnover = (orders * orderSize * 0.58).toFixed(1);
    const burn = Math.max(0.01, orders * orderSize * 0.0018);
    const runwayHours = (agents * budget) / Math.max(0.01, orders * orderSize * 0.025);
    const risk = Math.min(94, Math.round((180 - cadence) / 3 + orderSize * 9 + (120 - spread) / 5));
    return { orders, turnover, runway: runwayHours > 48 ? `${Math.round(runwayHours / 24)}d` : `${Math.max(1, Math.round(runwayHours))}h`, risk: Math.max(12, risk), fees: (burn * 24).toFixed(2), utilization: Math.min(96, Math.round(35 + orderSize * 12 + agents * 2)) };
  }, [agents, budget, cadence, orderSize, spread, strategy]);
  const pulseProps: PulseProps = { strategy, setStrategy, agents, setAgents, budget, setBudget, cadence, setCadence, orderSize, setOrderSize, spread, setSpread, inventory, setInventory, simulated, setSimulated, running, setRunning, plan: pulsePlan };
  const pickPreset = (name: Preset, presetMev: number) => { setPreset(name); setMev(presetMev); };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMobileNav(false); document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const changeView = (nextView: View) => {
    setExploringRobinhood(false);
    setView(nextView);
    setMobileNav(false);
  };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-zone"><button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation" aria-expanded={mobileNav} aria-controls="project-navigation"><Menu /></button><div className="brand-mark"><i /><i /><i /><i /></div><strong>PulseForge <span>v1.1</span></strong><PanelLeftClose className="ml-auto size-4 text-[#717789]" /></div>
      <nav className="steps" aria-label="Product sections"><button onClick={() => changeView('chain')} className={view === 'chain' ? 'active' : ''}>01 VENUE</button><button onClick={() => changeView('token')} className={view === 'token' ? 'active' : ''}>02 TOKEN</button><button onClick={() => changeView('launch')} className={view === 'launch' ? 'active' : ''}>03 PLAN</button><button onClick={() => changeView('funding')} className={view === 'funding' ? 'active' : ''}>04 FUNDING</button><button onClick={() => changeView('distribution')} className={view === 'distribution' ? 'active distro-nav' : 'distro-nav'}>05 DISTRO</button><button onClick={() => changeView('live')} className={view === 'live' ? 'active' : ''}>06 OPS PREVIEW</button><button onClick={() => changeView('pulse')} className={view === 'pulse' ? 'active pulse-nav' : 'pulse-nav'}>PULSE</button><button onClick={() => changeView('tracker')} className={view === 'tracker' ? 'active tracker-nav' : 'tracker-nav'}>SUPPLY</button></nav>
      <div className="token-zone"><div className="token-avatar">{ticker.slice(0, 2) || 'PF'}<span /></div><div><strong>${ticker || 'TOKEN'} <small>{tokenName || 'Untitled'}</small></strong><p>{exploringRobinhood ? `Robinhood · ${robinhoodVenue} · Planning only` : `${chain} · ${launchpad} · ${currency}`}</p></div><Button variant="outline" className="archive-button" onClick={() => void saveLaunchPlan()} disabled={exploringRobinhood || saveBusy || persistenceState === 'saving' || Boolean(planValidation.error)}><Database /> {persistenceState === 'saving' ? 'Saving' : savedAt ? 'Saved' : 'Save plan'}</Button></div>
    </header>

    {mobileNav && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside id="project-navigation" className={`sidebar ${mobileNav ? 'open' : ''}`} aria-label="Project navigation">
      <nav className="sidebar-section planning-navigation" aria-label="Launch planning">
        <p>Launch planning</p>
        {([['chain', '01', 'Venue'], ['token', '02', 'Token details'], ['launch', '03', 'Launch settings'], ['live', '06', 'Operations preview']] as const).map(([target, step, label]) => <button key={target} aria-current={view === target ? 'page' : undefined} className={view === target ? 'feature-active' : ''} onClick={() => changeView(target)}><span className="nav-step">{step}</span>{label}</button>)}
      </nav>
      <section className="workspace-card" aria-label="Current workspace"><span>CURRENT WORKSPACE</span><div><span className="workspace-mark">PF</span><span><strong>PulseForge Console</strong><small>Planning & devnet workspace</small></span><em>ACTIVE</em></div><p>Launch planning, wallet verification, devnet distribution, simulation, and supply analysis.</p></section>
      <div className="sidebar-section"><p>Available tools</p><button onClick={() => changeView('funding')} className={view === 'funding' ? 'feature-active' : ''}><WalletCards /> Wallet & funding</button><button onClick={() => changeView('distribution')} className={view === 'distribution' ? 'feature-active distro-active' : ''}><Boxes /> Devnet distribution <b>DEVNET</b></button><button onClick={() => changeView('pulse')} className={view === 'pulse' ? 'feature-active' : ''}><Bot /> Pulse simulation</button><button onClick={() => changeView('tracker')} className={view === 'tracker' ? 'feature-active tracker-active' : ''}><Crosshair /> Supply analysis</button></div>
      <div className="sidebar-bottom"><div><Button variant="outline" onClick={() => void saveLaunchPlan()} disabled={exploringRobinhood || saveBusy || persistenceState === 'saving' || Boolean(planValidation.error)}><Database /> Save plan</Button><Button onClick={() => { revision.current.edit(); setPersistenceState('ready'); setExploringRobinhood(false); setLaunchPlan(DEFAULT_LAUNCH_PLAN); setSavedAt(null); setPlanMessage('New unsaved launch plan.'); setView('chain'); }}><Sparkles /> New plan</Button></div></div>
    </aside>

    <main className={`workspace ${!exploringRobinhood && (view === 'tracker' || view === 'distribution') ? 'tracker-workspace' : ''}`}>
      {exploringRobinhood ? <RobinhoodPlanner venue={robinhoodVenue} onSelect={setRobinhoodVenue} onBack={() => { setExploringRobinhood(false); setView('chain'); }} /> : view === 'tracker' ? <SupplyTracker /> : view === 'distribution' ? (canUseDevnetTools(chain) ? <DistributionWorkbench /> : <section className="settings-panel"><div className="page-title"><span className="eyebrow">SOLANA DEVNET ONLY</span><h1>Distribution unavailable</h1><p>{chain} has no verified wallet or distribution integration. Your plan remains a draft.</p><Button className="flow-next" onClick={() => changeView('chain')}>Review chain selection</Button></div></section>) : <>
      <section className="settings-panel">{view === 'chain' ? <ChainLaunchForm onExploreRobinhood={() => setExploringRobinhood(true)} plan={launchPlan} onChange={updateLaunchPlan} onNext={() => setView('token')} /> : view === 'token' ? <TokenDetailsForm plan={launchPlan} onChange={updateLaunchPlan} onNext={() => setView('launch')} /> : view === 'funding' ? <FundingForm plan={launchPlan} estimate={figures} validationError={planValidation.error} onChange={updateLaunchPlan} onNext={() => setView('distribution')} /> : view === 'live' ? <LiveOperationsForm plan={launchPlan} onOpenSimulation={() => setView('pulse')} /> : view === 'launch' ? <div className="settings-scroll">
        <div className="page-title"><h1>Launch Settings</h1><p>Model allocations and compare scenarios. Nothing here submits a launch or schedules a trade.</p></div>
        <div className="form-body">
          <div className="mode-tabs">{([['Block-0', CircleGauge], ['Organic', Leaf], ['Manual', Hand]] as Array<[Mode, typeof Leaf]>).map(([name, Icon]) => <button key={name} onClick={() => setMode(name)} className={mode === name ? 'active' : ''}><Icon /> {launchModeLabel(name)} Mode</button>)}</div>
          <div className="input-grid">
            <div><FieldLabel optional><Gem className="size-3.5 text-[#f7cb49]" />Developer Buy %</FieldLabel><div className="number-wrap"><Input value={developer} onChange={(e) => setDeveloper(Number(e.target.value))} type="number" min={0} max={100} /><span>%</span></div></div>
            <div><FieldLabel note="(Excluding Developer)"><Sparkles className="size-3.5 text-[#8e83ff]" />Holders Buy</FieldLabel><div className="number-wrap"><Input value={holders} onChange={(e) => setHolders(Number(e.target.value))} type="number" min={0} max={100} /><span>%</span></div></div>
          </div>
          <div className="mt-4"><FieldLabel note="(1-200)"><Users className="size-3.5 text-[#43efc1]" />Holders Count</FieldLabel><Input value={holderCount} onChange={(e) => setHolderCount(Number(e.target.value))} type="number" min={1} max={200} /></div>
          <div className="section-label"><Boxes /> Scenario preset</div>
          <div className="preset-grid">{presets.map(({ name, blurb, icon: Icon, mev: presetMev }) => <button key={name} onClick={() => pickPreset(name, presetMev)} className={preset === name ? 'active' : ''}><span><Icon />{name} <b>Build</b></span><small>{blurb}</small></button>)}</div>
          <div className="section-label"><Crosshair /> Scenario routing emphasis</div><Slider value={[mev]} onValueChange={(v) => { setMev(typeof v === 'number' ? v : v[0]); setPreset('Custom'); }} min={0} max={100} step={1} className="mev-slider" /><div className="range-labels"><span>Earlier stages</span><span>Distributed stages</span></div>
          <div className="wallet-card"><div className="wallet-head"><span><WalletCards /></span><div><strong>Wallet role plan</strong><p>Counts are planning inputs; wallet custody is not connected</p></div></div><div className="wallet-types"><button type="button" disabled><Gem /> Deployer <b>0/1</b></button><button type="button" disabled><Users /> Scenario recipients <b>0/{holderCount}</b></button></div><button type="button" disabled className="edit-selection"><Pencil /> Custody locked</button></div>
          <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)}><Settings /> ADVANCED INTEGRATION PARAMETERS · LOCKED<i /><ChevronDown className={advanced ? 'rotate' : ''} /></button>
          {advanced && <fieldset disabled className="advanced-grid" aria-label="Advanced integration parameters are unavailable"><div><FieldLabel optional note="(0-100)">Slippage</FieldLabel><div className="number-wrap"><Input defaultValue="100" /><span>%</span></div></div><div><FieldLabel optional>Funding Delay</FieldLabel><div className="delay"><span>MIN</span><b>:</b><span>SEC</span></div></div><div><FieldLabel optional note="(0-100)">Alternative Routing</FieldLabel><div className="number-wrap"><Input placeholder="0" /><span>%</span></div></div><div><FieldLabel optional note="(0-200)">Empty Holders</FieldLabel><Input defaultValue="0" /></div><div className="wide"><FieldLabel optional>Fee Target</FieldLabel><div className="number-wrap"><Input defaultValue="0" /><span className="sol">◎</span></div></div></fieldset>}
          <div className="scheduled"><span><strong>Scheduled simulation</strong><small>Record the deployment and holder phases separately for review. No transaction is scheduled.</small></span><input aria-label="Scheduled simulation" type="checkbox" checked={scheduled} onChange={(event) => updateLaunchPlan({ scheduled: event.target.checked })} /><i /></div><Button className="create-main" onClick={() => changeView('funding')}><Landmark /> Review funding plan</Button>
        </div>
      </div> : <PulseForm {...pulseProps} />}</section>

      <aside className="insights">{view === 'chain' || view === 'token' || view === 'funding' || view === 'live' ? <PlanRail plan={launchPlan} savedAt={savedAt} persistenceState={persistenceState} validationError={planValidation.error} /> : view === 'launch' ? <div className="insights-scroll">
        <section className="mode-summary"><div className="summary-title"><CircleGauge /><strong>{launchModeLabel(mode)} Mode</strong><span>Planning model</span></div><p>{mode === 'Block-0' ? 'Models an ordered sequence for review. It does not guarantee same-slot or Block-0 inclusion.' : mode === 'Organic' ? 'Models staggered buys across slots with configurable pacing and exposure.' : 'Models funding allocations for manual review. No funds are distributed.'}</p><div className="pros"><span>+++ &nbsp; Deterministic planning</span><span>--- &nbsp; External flow remains</span><span>+++ &nbsp; Auditable stages</span><span>-- &nbsp; Higher complexity</span><span>+++ &nbsp; Explicit scenario roles</span><span>- &nbsp; Mainnet execution unavailable</span></div></section>
        <section className="build-analysis"><h2><Gauge /> {preset} Build <ChevronDown /></h2><div className="metric-grid"><div><div className="metric-label"><Users /> Cluster outcome <Help /><b>UNVERIFIED</b></div><Meter value={mev + 12} left="Unknown" right="Needs live proof" /></div><div><div className="metric-label"><CircleGauge /> Scenario cost <Help /><b>{figures.supplyCost}</b></div><Meter value={Math.min(94, Number(figures.supplyCost) * 9)} left="Lower" right="Higher" /></div><div><div className="metric-label"><Target /> Routing emphasis <Help /></div><Meter value={mev} left="Earlier" right="Distributed" /></div><div><div className="metric-label"><Activity /> Planned duration <Help /><b>{Math.round(64 - mev / 5)}m {Math.round(mev % 60)}s</b></div><Meter value={Math.min(96, holderCount / 2)} left="Fastest" right="Longest" /></div></div></section>
        <section className="estimate-card"><div className="est-row muted"><span>Estimate source <Help /></span><b>{planValidation.error ? 'PLAN INVALID · ESTIMATES PAUSED' : 'VALIDATED PLAN · NO LIVE QUOTE'}</b></div><div className="est-row"><span>Illustrative allocation <Help /></span><b><strong>{planValidation.error ? '—' : `${figures.allocation}%`}</strong></b></div><div className="sub-row"><span>Deployer <Help /></span><b>{developer}%</b></div><div className="sub-row"><span>Holders <Help /></span><b>{holders}%</b></div></section>
        <section className="estimate-card funding-card"><div className="est-row"><span>Illustrative funding scenario</span><b>{figures.scenarioTotal} {chain === 'Solana' ? 'SOL' : currency}</b></div><div className="sub-row"><span>Allocation scenario <Help /></span><b>{figures.supplyCost}</b></div><div className="sub-row"><span>Wallet reserve <Help /></span><b>{figures.walletReserve}</b></div><div className="sub-row danger"><span>Maximum modeled exposure <Help /></span><b>{figures.maximumExposure}</b></div></section><Button className="create-side" onClick={() => changeView('funding')}><Landmark /> Review funding</Button>
      </div> : <PulseInsights {...pulseProps} />}</aside></>}
    </main>
    <footer className="statusbar"><span className="live"><i /> {exploringRobinhood ? 'Robinhood · Read-only research' : chain === 'Solana' ? `Solana · ${runtimeStatus}` : `${chain} · Planning only · Execution locked`}</span><span className={`plan-save-state ${planValidation.error ? 'error' : persistenceState}`}>{planValidation.error ?? planMessage}</span><span className="network-boundary">DEVNET TOOLS · MAINNET LOCKED</span></footer>
  </div>;
}
