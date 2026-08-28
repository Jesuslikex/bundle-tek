'use client';

import { useMemo, useState } from 'react';
import {
  Activity, Archive, Boxes, ChevronDown, CircleGauge, CircleHelp, Clipboard, Crosshair,
  Database, ExternalLink, Flame, Gauge, Gem, Grid2X2, Hand, Leaf, Menu,
  MessageCircle, PanelLeftClose, Pencil, Search, Settings, Shield, Sparkles,
  Target, Users, WalletCards, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';

type Mode = 'Block-0' | 'Organic' | 'Manual';
type Preset = 'Quick' | 'Clean' | 'Full' | 'Custom';
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

export default function Home() {
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
  const figures = useMemo(() => {
    const supply = Math.min(100, developer + holders - (mev / 100) * 0.98);
    const cost = supply * 0.369 + holderCount * 0.0015;
    const extra = holderCount * 0.171 + holders * 0.109;
    const funding = cost + extra;
    return { supply: supply.toFixed(2), cost: cost.toFixed(2), extra: extra.toFixed(2), funding: funding.toFixed(2), lossLow: (cost * 0.283).toFixed(2), lossHigh: (cost * 0.59).toFixed(2), market: Math.round(2910 + holders * 96) };
  }, [developer, holders, holderCount, mev]);
  const pickPreset = (name: Preset, presetMev: number) => { setPreset(name); setMev(presetMev); };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-zone"><button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation"><Menu /></button><div className="brand-mark"><i /><i /><i /><i /></div><strong>Proxima <span>v0.9</span></strong><PanelLeftClose className="ml-auto size-4 text-[#717789]" /></div>
      <nav className="steps" aria-label="Token creation steps"><button>CHAIN &amp; LAUNCHPAD</button><button>TOKEN DETAILS</button><button className="active">LAUNCH SETTINGS</button></nav>
      <div className="token-zone"><div className="token-avatar">xD<span /></div><div><strong>$xD <small>xD</small></strong><p>6pFG2n...Npump</p></div><Button variant="outline" className="archive-button"><Archive /> Archive</Button></div>
    </header>

    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <div className="project-search"><Search /><input placeholder="Search" /><kbd>⌘K</kbd></div>
      <div className="project-list">{projects.map((project, index) => <button key={project.ticker} className={`project ${index === 0 ? 'selected' : ''}`}><span className="project-avatar" style={{ background: `linear-gradient(145deg, ${project.color}, #16171d)` }}>{project.name.slice(0, 2)}</span><span><strong>{project.ticker}</strong><small>{project.name}</small></span><em>{project.state}</em></button>)}</div>
      <div className="sidebar-section"><p>Features <ChevronDown /></p><a><WalletCards /> My Wallets</a><a><Grid2X2 /> Marketplace <b>NEW</b></a><a><Activity /> Tracker</a><a><Archive /> Archived</a><a><Boxes /> Dashboard</a></div>
      <div className="sidebar-bottom"><button className="funder"><Database /> Funder <ChevronDown /></button><div><Button variant="outline"><Clipboard /> Import</Button><Button><Sparkles /> Create Launch</Button></div></div>
    </aside>

    <main className="workspace">
      <section className="settings-panel"><div className="settings-scroll">
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
          <div className="section-label"><Crosshair /> Back MEV Tuning</div><Slider value={[mev]} onValueChange={(v) => { setMev(v[0]); setPreset('Custom'); }} min={0} max={100} step={1} className="mev-slider" /><div className="range-labels"><span>Less Sniper</span><span>Less Top Trader</span></div>
          <div className="wallet-card"><div className="wallet-head"><span><WalletCards /></span><div><strong>Import Wallets</strong><p>Paste private keys or import from your wallets</p></div></div><div className="wallet-types"><button><Gem /> Deployer <b>0/1</b></button><button className="selected"><Users /> Holders <b>{holderCount}/190</b></button><button><Flame /> Front MEV <b>0/5</b></button><button><Target /> Back MEV <b>0/17</b></button></div><button className="edit-selection"><Pencil /> Edit Selection</button></div>
          <label className="check-row"><Checkbox checked={cex} onCheckedChange={(v) => setCex(Boolean(v))} /><span>🛫🟡 <strong>CEX Funding</strong><small>Fund wallets through CEXs. Service fees may vary from .25% to 2%.</small></span></label>
          <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)}><Settings /> ADVANCED SETTINGS (OPTIONAL)<i /><ChevronDown className={advanced ? 'rotate' : ''} /></button>
          {advanced && <div className="advanced-grid"><div><FieldLabel optional note="(0-100)">Slippage</FieldLabel><div className="number-wrap"><Input defaultValue="100" /><span>%</span></div></div><div><FieldLabel optional>Funding Delay</FieldLabel><div className="delay"><span>MIN</span><b>:</b><span>SEC</span></div></div><div><FieldLabel optional note="(0-100)">Alternative Routing</FieldLabel><div className="number-wrap"><Input placeholder="0" /><span>%</span></div></div><div><FieldLabel optional note="(0-200)">Empty Holders</FieldLabel><Input defaultValue="0" /></div><div className="wide"><FieldLabel optional>Fee Target</FieldLabel><div className="number-wrap"><Input defaultValue="0" /><span className="sol">◎</span></div></div></div>}
          <label className="scheduled"><span><strong>Scheduled Mode</strong><small>Deploy and dev buy execute at launch. Holder buys wait until you click Snipe on the live page.</small></span><input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} /><i /></label><Button className="create-main"><Sparkles /> Create</Button>
        </div>
      </div></section>

      <aside className="insights"><div className="insights-scroll">
        <section className="mode-summary"><div className="summary-title"><CircleGauge /><strong>{mode} Mode</strong><a>View in documentation <ExternalLink /></a></div><p>{mode === 'Block-0' ? 'Prioritizes execution certainty and sniper resistance over organic price action, making it ideal for competitive launches.' : mode === 'Organic' ? 'Uses staggered buys to create a more natural early market profile.' : 'Gives you direct control of every execution input.'}</p><div className="pros"><span>+++ &nbsp; High Pressure Launches</span><span>--- &nbsp; Less natural price action</span><span>+++ &nbsp; Guaranteed supply</span><span>-- &nbsp; More Expensive</span><span>+++ &nbsp; Can’t Get Frontrun</span><span>- &nbsp; Overkill for Small Launch</span></div></section>
        <section className="build-analysis"><h2><Gauge /> {preset} Build <ChevronDown /></h2><div className="metric-grid"><div><label><Users /> Bubble Maps <Help /><b>Likely Clean</b></label><Meter value={mev + 12} left="Uncertain" right="Likely clean" /></div><div><label><CircleGauge /> Supply Cost <Help /><b>{(Number(figures.cost) / 1.88).toFixed(1)}%</b></label><Meter value={Math.min(94, Number(figures.cost) * 9)} left="Low" right="High" /></div><div><label><Target /> Detection Mode <Help /></label><Meter value={mev} left="Less Sniper" right="Less Top Traders" /></div><div><label><Activity /> Cleanup Time <Help /><b>{Math.round(64 - mev / 5)}m {Math.round(mev % 60)}s</b></label><Meter value={Math.min(96, holderCount / 2)} left="Fastest" right="Longest" /></div></div></section>
        <section className="estimate-card"><div className="est-row muted"><span>Est. Market Cap <Help /></span><b>$2.91K → $4.83K–<strong>${(figures.market / 1000).toFixed(2)}K</strong> / $42.7K</b></div><div className="est-row"><span>Expected Supply <Help /></span><b>{figures.supply}%→<strong>{Math.round(developer + holders)}%</strong></b></div><div className="sub-row"><span>Deployer <Help /></span><b>{developer}%</b></div><div className="sub-row"><span>Holders <Help /></span><b>{figures.supply}%→{holders}%</b></div></section>
        <section className="estimate-card funding-card"><div className="est-row"><span>Funding Estimation</span><b>{figures.funding} SOL</b></div><div className="sub-row"><span>Supply Cost <Help /></span><b>{figures.cost} SOL</b></div><div className="sub-row"><span>Extra Funding <Help /></span><b>{figures.extra} SOL</b></div><div className="sub-row danger"><span>Maximum Loss <Help /></span><b>{figures.lossLow} SOL / {figures.lossHigh} SOL</b></div></section><Button className="create-side"><Sparkles /> Create</Button>
      </div></aside>
    </main>
    <footer className="statusbar"><span className="live"><i /> All Services are Live • 167ms</span><div className="prices"><span>◎ <b>$103</b> ↗</span><span>⬡ <b>$688</b> ↗</span><span>◆ <b>$2,431</b> ↘</span></div><nav><a>𝕏</a><a><MessageCircle /></a><a>News</a><a>Documentation</a><a>Activity</a><a><CircleHelp /></a><a><Settings /> Settings</a></nav></footer>
  </div>;
}
