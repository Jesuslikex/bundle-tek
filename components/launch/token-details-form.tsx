'use client';

import { ChevronDown, GitBranch, ImagePlus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { LaunchPlanInput } from '@/lib/launch-plan';

function Label({ children, optional }: { children: React.ReactNode; optional?: boolean }) {
  return <label className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[#eaebf0]">{children}{optional ? <span className="font-normal text-[#72788a]">(optional)</span> : null}</label>;
}

export function TokenDetailsForm({
  plan,
  onChange,
  onNext,
}: {
  plan: LaunchPlanInput;
  onChange: (change: Partial<LaunchPlanInput>) => void;
  onNext: () => void;
}) {
  const ready = plan.tokenName.trim().length > 1 && plan.ticker.trim().length > 0;
  return <div className="settings-scroll launch-flow-scroll">
    <div className="page-title"><span className="eyebrow"><Sparkles /> LAUNCH PLAN / STEP 02</span><h1>Token Details</h1><p>Define the public identity saved with this plan.<br />Metadata remains private until an approved creation path exists.</p></div>
    <div className="form-body token-form">
      <div className="input-grid"><div><Label>Project name</Label><Input value={plan.tokenName} onChange={(event) => onChange({ tokenName: event.target.value.slice(0, 32) })} placeholder="Pulse token" /><small>{plan.tokenName.length}/32</small></div><div><Label>Symbol</Label><Input value={plan.ticker} onChange={(event) => onChange({ ticker: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 13) })} placeholder="PULSE" /><small>{plan.ticker.length}/13</small></div></div>
      <div><Label optional>Description</Label><textarea value={plan.description} onChange={(event) => onChange({ description: event.target.value.slice(0, 280) })} placeholder="What is this token for?" /><small>{plan.description.length}/280</small></div>
      <div className="metadata-grid"><button type="button" disabled><ImagePlus /><span><strong>Token artwork</strong><small>Asset upload not connected</small></span><b>LOCKED</b></button><button type="button" disabled><GitBranch /><span><strong>Custom mint address</strong><small>Vanity generation not connected</small></span><b>LOCKED</b></button></div>
      <div className="social-preview"><span className="token-preview-avatar">{plan.ticker.slice(0, 2) || 'PF'}</span><span><strong>{plan.tokenName || 'Untitled token'}</strong><small>${plan.ticker || 'TOKEN'} · {plan.launchpad} on {plan.chain}</small></span><em>DRAFT</em></div>
      <Button className="flow-next" disabled={!ready} onClick={onNext}>Build execution plan <ChevronDown /></Button>
    </div>
  </div>;
}
