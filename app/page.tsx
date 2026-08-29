'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Activity, Archive, Boxes, ChevronDown, CircleGauge, CircleHelp, Clipboard, Crosshair,
  Database, ExternalLink, Flame, Gauge, Gem, Grid2X2, Hand, Leaf, Menu,
  MessageCircle, PanelLeftClose, Pencil, Search, Settings, Shield, Sparkles,
  BarChart3, Bot, CircleDollarSign, Play, Radio, RefreshCw, SlidersHorizontal,
  Target, TimerReset, TrendingUp, TriangleAlert, Users, WalletCards, Waves, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { SupplyTracker } from '@/components/supply-tracker';

type Mode = 'Block-0' | 'Organic' | 'Manual';
type Preset = 'Quick' | 'Clean' | 'Full' | 'Custom';
type View = 'launch' | 'pulse' | 'tracker';
type Strategy = 'Balanced' | 'Liquidity' | 'Discovery';
const projects = [
  { ticker: '$xD', name: 'xD', state: 'Draft', color: '#8577ff' },
  { ticker: '$CLICK', name: 'One Click Can Change', state: 'Import', color: '#f43f9d' },
  { ticker: '$FRONG', name: 'frong', state: 'Import', color: '#f59e0b' },
  { ticker: '$MUMU', name: 'Mumu The Bull', state: 'Import', color: '#22c55e' },
  { ticker: '$NINEHOOD', name: 'NINEHOOD', state: 'Import', color: '#b5f231' },
  { ticker: '$test', name: 'Test', state: 'Draft', color: '#fb7185' },
];
const presets: Array<{ name: Preset; blurb: string; icon: typeof Zap; mev: number }> = [
  { name: 'Quick', blurb: 'Fast, low cost', icon: Zap, mev: 35 },
  { name: 'Clean', blurb: 'Balanced stealth', icon: CircleGauge, mev: 46 },
  { name: 'Full', blurb: 'Max stealth', icon: Shield, mev: 78 },
  { name: 'Custom', blurb: 'Manual inputs', icon: Settings, mev: 55 },
];

function Help() { return <CircleHelp className="inline size-3 text-[#697083]" aria-hidden="true" />; }
function FieldLabel({ children, optional, note }: { children: React.ReactNode; optional?: boolean; note?: string }) {
  return <label className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[#eaebf0]">{children}{optional && <span className="font-normal text-[#72788a]">(optional)</span>}{note && <span className="font-normal text-[#72788a]">{note}</span>}<Help /></label>;
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

  const loadBackend = async () => {
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
        if (strategy.strategy) props.setStrategy(strategy.strategy);
        if (strategy.agents) props.setAgents(Number(strategy.agents));
        if (strategy.budget) props.setBudget(Number(strategy.budget));
        if (strategy.cadence) props.setCadence(Number(strategy.cadence));
        if (strategy.orderSize) props.setOrderSize(Number(strategy.orderSize));
        if (strategy.spread) props.setSpread(Number(strategy.spread));
        if (strategy.inventory) props.setInventory(Number(strategy.inventory));
      }
      const cyclesResponse = await fetch('/api/pulse/cycles', { cache: 'no-store' });
      if (cyclesResponse.ok) setCycles(((await cyclesResponse.json()) as { cycles: BackendCycle[] }).cycles);
      setState('ready'); setMessage(saved.strategy ? 'Saved strategy loaded from D1.' : 'Backend online. Save this strategy to begin.');
    } catch (error) {
      setState('error'); setMessage(error instanceof Error ? error.message : 'Backend unavailable');
    }
  };

  useEffect(() => { void loadBackend(); }, []);

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
    {state === 'auth' ? <a className="backend-signin" href="/signin-with-chatgpt?return_to=/" target="_top">Sign in with ChatGPT</a> : <div className="backend-actions"><Button variant="outline" onClick={() => void saveStrategy()} disabled={state === 'working'}><Database /> Save strategy</Button><Button className={`pulse-action ${props.running ? 'is-running' : ''}`} onClick={() => void runCycle()} disabled={state === 'working'}>{props.running ? <><RefreshCw className="animate-spin" /> Running live-data cycle</> : <><Play /> Run live-data cycle</>}</Button></div>}
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
    <div className="page-title pulse-title"><span className="eyebrow"><Radio /> OUR TECH / PULSE ENGINE</span><h1>Market Maker</h1><p>Inventory-aware liquidity automation with transparent risk controls.<br />Built to support real markets—not fabricate investor activity.</p></div>
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
      <div className="safety-grid"><div><Shield /><span><strong>Self-trade prevention</strong><small>Wallet and route collision checks</small></span><b>ON</b></div><div><TriangleAlert /><span><strong>Volatility brake</strong><small>Pause above 8% / 5m movement</small></span><b>ON</b></div><div><Activity /><span><strong>Organic throttle</strong><small>Reduce quotes when real flow rises</small></span><b>ON</b></div><div><Target /><span><strong>Daily loss limit</strong><small>Hard stop at 8% of budget</small></span><b>ON</b></div></div>
      <label className="simulation-row"><Checkbox checked={props.simulated} onCheckedChange={(v) => props.setSimulated(Boolean(v))} /><span><strong>Simulation mode</strong><small>No transactions are signed or submitted. Review the projected behavior before connecting execution.</small></span></label>
      <PulseBackendControls {...props} />
    </div>
  </div>;
}

function PulseInsights({ strategy, agents, budget, cadence, orderSize, spread, inventory, running, plan }: PulseProps) {
  const ticks = [31, 45, 38, 57, 51, 67, 61, 74, 69, 82, 77, 89];
  return <div className="insights-scroll pulse-insights">
    <section className="pulse-status"><div><span className={running ? 'pulse-dot active' : 'pulse-dot'} /><div><small>ENGINE STATE</small><strong>{running ? 'SIMULATING' : 'READY'}</strong></div></div><em>PX-01</em></section>
    <section className="pulse-chart"><div className="pulse-chart-head"><span><BarChart3 /> Projected liquidity profile</span><b>{strategy}</b></div><div className="mini-chart">{ticks.map((value, index) => <i key={index} style={{ height: `${Math.min(96, value + agents)}%` }} />)}<span className="midline" /></div><div className="chart-labels"><span>Bid depth</span><span>Mid</span><span>Ask depth</span></div></section>
    <section className="pulse-kpis"><div><small>Projected orders / hr</small><strong>{plan.orders}</strong><em>adaptive</em></div><div><small>Capital deployed</small><strong>{(agents * budget).toFixed(1)} SOL</strong><em>{plan.utilization}% utilized</em></div><div><small>Est. two-sided turnover</small><strong>{plan.turnover} SOL</strong><em>scenario only</em></div><div><small>Budget runway</small><strong>{plan.runway}</strong><em>at current cadence</em></div></section>
    <section className="risk-map"><h2><Shield /> Safety envelope <b>{plan.risk < 45 ? 'CONSERVATIVE' : plan.risk < 70 ? 'MODERATE' : 'AGGRESSIVE'}</b></h2><div className="risk-meter"><i style={{ width: `${plan.risk}%` }} /></div><div className="risk-values"><span>Spread <b>{spread} bps</b></span><span>Order cap <b>{orderSize.toFixed(2)} SOL</b></span><span>Cadence <b>{cadence}s</b></span><span>Inventory <b>{inventory}/{100 - inventory}</b></span></div></section>
    <section className="estimate-card pulse-estimate"><div className="est-row"><span>Scenario cost</span><b>{plan.fees} SOL / day</b></div><div className="sub-row"><span>Self-trade checks</span><b className="safe">ENFORCED</b></div><div className="sub-row"><span>External execution</span><b>NOT CONNECTED</b></div><div className="sub-row"><span>Mode</span><b>SIMULATION ONLY</b></div></section>
    <div className="execution-note"><TriangleAlert /><p><strong>Execution remains locked.</strong> Connecting wallets, signing trades, or activating a live strategy requires a separate reviewed integration and explicit approval.</p></div>
  </div>;
}

export default function Home() {
  const [view, setView] = useState<View>('launch');
  const [mode, setMode] = useState<Mode>('Block-0');
  const [preset, setPreset] = useState<Preset>('Clean');
  const [developer, setDeveloper] = useState(5);
  const [holders, setHolders] = useState(20);
  const [holderCount, setHolderCount] = useState(190);
  const [mev, setMev] = useState(46);
  const [advanced, setAdvanced] = useState(true);
  const [cex, setCex] = useState(false);
  const [scheduled, setScheduled] = useState(false);
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
  const figures = useMemo(() => {
    const supply = Math.min(100, developer + holders - (mev / 100) * 0.98);
    const cost = supply * 0.369 + holderCount * 0.0015;
    const extra = holderCount * 0.171 + holders * 0.109;
    const funding = cost + extra;
    return { supply: supply.toFixed(2), cost: cost.toFixed(2), extra: extra.toFixed(2), funding: funding.toFixed(2), lossLow: (cost * 0.283).toFixed(2), lossHigh: (cost * 0.59).toFixed(2), market: Math.round(2910 + holders * 96) };
  }, [developer, holders, holderCount, mev]);
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

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-zone"><button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation"><Menu /></button><div className="brand-mark"><i /><i /><i /><i /></div><strong>PulseForge <span>v1.0</span></strong><PanelLeftClose className="ml-auto size-4 text-[#717789]" /></div>
      <nav className="steps" aria-label="Product sections"><button>CHAIN &amp; LAUNCHPAD</button><button>TOKEN DETAILS</button><button onClick={() => setView('launch')} className={view === 'launch' ? 'active' : ''}>LAUNCH SETTINGS</button><button onClick={() => setView('pulse')} className={view === 'pulse' ? 'active pulse-nav' : 'pulse-nav'}>PULSE ENGINE</button><button onClick={() => setView('tracker')} className={view === 'tracker' ? 'active tracker-nav' : 'tracker-nav'}>SUPPLY TRACKER</button></nav>
      <div className="token-zone"><div className="token-avatar">xD<span /></div><div><strong>$xD <small>xD</small></strong><p>6pFG2n...Npump</p></div><Button variant="outline" className="archive-button"><Archive /> Archive</Button></div>
    </header>

    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <div className="project-search"><Search /><input placeholder="Search" /><kbd>⌘K</kbd></div>
      <div className="project-list">{projects.map((project, index) => <button key={project.ticker} className={`project ${index === 0 ? 'selected' : ''}`}><span className="project-avatar" style={{ background: `linear-gradient(145deg, ${project.color}, #16171d)` }}>{project.name.slice(0, 2)}</span><span><strong>{project.ticker}</strong><small>{project.name}</small></span><em>{project.state}</em></button>)}</div>
      <div className="sidebar-section"><p>Features <ChevronDown /></p><a onClick={() => setView('pulse')} className={view === 'pulse' ? 'feature-active' : ''}><Bot /> Pulse Engine <b>LAB</b></a><a><WalletCards /> My Wallets</a><a><Grid2X2 /> Marketplace <b>NEW</b></a><a onClick={() => setView('tracker')} className={view === 'tracker' ? 'feature-active tracker-active' : ''}><Activity /> Supply Tracker</a><a><Archive /> Archived</a><a><Boxes /> Dashboard</a></div>
      <div className="sidebar-bottom"><button className="funder"><Database /> Funder <ChevronDown /></button><div><Button variant="outline"><Clipboard /> Import</Button><Button><Sparkles /> Create Launch</Button></div></div>
    </aside>

    <main className={`workspace ${view === 'tracker' ? 'tracker-workspace' : ''}`}>
      {view === 'tracker' ? <SupplyTracker /> : <>
      <section className="settings-panel">{view === 'launch' ? <div className="settings-scroll">
        <div className="page-title"><h1>Launch Settings</h1><p>Define how your launch behaves on-chain.<br />These settings control execution patterns.</p></div>
        <div className="form-body">
          <div className="mode-tabs">{([['Block-0', CircleGauge], ['Organic', Leaf], ['Manual', Hand]] as Array<[Mode, typeof Leaf]>).map(([name, Icon]) => <button key={name} onClick={() => setMode(name)} className={mode === name ? 'active' : ''}><Icon /> {name} Mode</button>)}</div>
          <div className="input-grid">
            <div><FieldLabel optional><Gem className="size-3.5 text-[#f7cb49]" />Developer Buy %</FieldLabel><div className="number-wrap"><Input value={developer} onChange={(e) => setDeveloper(Number(e.target.value))} type="number" min={0} max={100} /><span>%</span></div></div>
            <div><FieldLabel note="(Excluding Developer)"><Sparkles className="size-3.5 text-[#8e83ff]" />Holders Buy</FieldLabel><div className="number-wrap"><Input value={holders} onChange={(e) => setHolders(Number(e.target.value))} type="number" min={0} max={100} /><span>%</span></div></div>
          </div>
          <div className="mt-4"><FieldLabel note="(1-200)"><Users className="size-3.5 text-[#43efc1]" />Holders Count</FieldLabel><Input value={holderCount} onChange={(e) => setHolderCount(Number(e.target.value))} type="number" min={1} max={200} /></div>
          <div className="section-label"><Boxes /> Block-0 Preset</div>
          <div className="preset-grid">{presets.map(({ name, blurb, icon: Icon, mev: presetMev }) => <button key={name} onClick={() => pickPreset(name, presetMev)} className={preset === name ? 'active' : ''}><span><Icon />{name} <b>Build</b></span><small>{blurb}</small></button>)}</div>
          <div className="section-label"><Crosshair /> Back MEV Tuning</div><Slider value={[mev]} onValueChange={(v) => { setMev(typeof v === 'number' ? v : v[0]); setPreset('Custom'); }} min={0} max={100} step={1} className="mev-slider" /><div className="range-labels"><span>Less Sniper</span><span>Less Top Trader</span></div>
          <div className="wallet-card"><div className="wallet-head"><span><WalletCards /></span><div><strong>Import Wallets</strong><p>Connect a supported wallet or add public addresses</p></div></div><div className="wallet-types"><button><Gem /> Deployer <b>0/1</b></button><button className="selected"><Users /> Holders <b>{holderCount}/190</b></button><button><Flame /> Front MEV <b>0/5</b></button><button><Target /> Back MEV <b>0/17</b></button></div><button className="edit-selection"><Pencil /> Edit Selection</button></div>
          <label className="check-row"><Checkbox checked={cex} onCheckedChange={(v) => setCex(Boolean(v))} /><span>🛫🟡 <strong>CEX Funding</strong><small>Fund wallets through CEXs. Service fees may vary from .25% to 2%.</small></span></label>
          <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)}><Settings /> ADVANCED SETTINGS (OPTIONAL)<i /><ChevronDown className={advanced ? 'rotate' : ''} /></button>
          {advanced && <div className="advanced-grid"><div><FieldLabel optional note="(0-100)">Slippage</FieldLabel><div className="number-wrap"><Input defaultValue="100" /><span>%</span></div></div><div><FieldLabel optional>Funding Delay</FieldLabel><div className="delay"><span>MIN</span><b>:</b><span>SEC</span></div></div><div><FieldLabel optional note="(0-100)">Alternative Routing</FieldLabel><div className="number-wrap"><Input placeholder="0" /><span>%</span></div></div><div><FieldLabel optional note="(0-200)">Empty Holders</FieldLabel><Input defaultValue="0" /></div><div className="wide"><FieldLabel optional>Fee Target</FieldLabel><div className="number-wrap"><Input defaultValue="0" /><span className="sol">◎</span></div></div></div>}
          <label className="scheduled"><span><strong>Scheduled Mode</strong><small>Deploy and dev buy execute at launch. Holder buys wait until you click Snipe on the live page.</small></span><input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} /><i /></label><Button className="create-main"><Sparkles /> Create</Button>
        </div>
      </div> : <PulseForm {...pulseProps} />}</section>

      <aside className="insights">{view === 'launch' ? <div className="insights-scroll">
        <section className="mode-summary"><div className="summary-title"><CircleGauge /><strong>{mode} Mode</strong><a>View in documentation <ExternalLink /></a></div><p>{mode === 'Block-0' ? 'Prioritizes execution certainty and sniper resistance over organic price action, making it ideal for competitive launches.' : mode === 'Organic' ? 'Uses staggered buys to create a more natural early market profile.' : 'Gives you direct control of every execution input.'}</p><div className="pros"><span>+++ &nbsp; High Pressure Launches</span><span>--- &nbsp; Less natural price action</span><span>+++ &nbsp; Guaranteed supply</span><span>-- &nbsp; More Expensive</span><span>+++ &nbsp; Can’t Get Frontrun</span><span>- &nbsp; Overkill for Small Launch</span></div></section>
        <section className="build-analysis"><h2><Gauge /> {preset} Build <ChevronDown /></h2><div className="metric-grid"><div><label><Users /> Bubble Maps <Help /><b>Likely Clean</b></label><Meter value={mev + 12} left="Uncertain" right="Likely clean" /></div><div><label><CircleGauge /> Supply Cost <Help /><b>{(Number(figures.cost) / 1.88).toFixed(1)}%</b></label><Meter value={Math.min(94, Number(figures.cost) * 9)} left="Low" right="High" /></div><div><label><Target /> Detection Mode <Help /></label><Meter value={mev} left="Less Sniper" right="Less Top Traders" /></div><div><label><Activity /> Cleanup Time <Help /><b>{Math.round(64 - mev / 5)}m {Math.round(mev % 60)}s</b></label><Meter value={Math.min(96, holderCount / 2)} left="Fastest" right="Longest" /></div></div></section>
        <section className="estimate-card"><div className="est-row muted"><span>Est. Market Cap <Help /></span><b>$2.91K → $4.83K–<strong>${(figures.market / 1000).toFixed(2)}K</strong> / $42.7K</b></div><div className="est-row"><span>Expected Supply <Help /></span><b>{figures.supply}%→<strong>{Math.round(developer + holders)}%</strong></b></div><div className="sub-row"><span>Deployer <Help /></span><b>{developer}%</b></div><div className="sub-row"><span>Holders <Help /></span><b>{figures.supply}%→{holders}%</b></div></section>
        <section className="estimate-card funding-card"><div className="est-row"><span>Funding Estimation</span><b>{figures.funding} SOL</b></div><div className="sub-row"><span>Supply Cost <Help /></span><b>{figures.cost} SOL</b></div><div className="sub-row"><span>Extra Funding <Help /></span><b>{figures.extra} SOL</b></div><div className="sub-row danger"><span>Maximum Loss <Help /></span><b>{figures.lossLow} SOL / {figures.lossHigh} SOL</b></div></section><Button className="create-side"><Sparkles /> Create</Button>
      </div> : <PulseInsights {...pulseProps} />}</aside></>}
    </main>
    <footer className="statusbar"><span className="live"><i /> All Services are Live • 167ms</span><div className="prices"><span>◎ <b>$103</b> ↗</span><span>⬡ <b>$688</b> ↗</span><span>◆ <b>$2,431</b> ↘</span></div><nav><a>𝕏</a><a><MessageCircle /></a><a>News</a><a>Documentation</a><a>Activity</a><a><CircleHelp /></a><a><Settings /> Settings</a></nav></footer>
  </div>;
}
