'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import { VenueMark } from './venue-mark';

function seconds(ms: number | undefined) {
  return `${((ms ?? 0) / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })}s`;
}

/**
 * Proxima-style "Launch Setup" summary shown before the funding review. It
 * only restates the saved draft; nothing here signs or submits.
 */
export function LaunchSetupDialog({
  open,
  plan,
  modeLabel,
  estimate,
  onOpenChange,
  onContinue,
}: {
  open: boolean;
  plan: LaunchPlanInput;
  modeLabel: string;
  estimate: { allocation: number | null; scenarioTotal: string };
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
}) {
  const tiles: [string, string][] = [
    ['Chain', plan.chain],
    ['Launchpad', plan.launchpad],
    ['Quote', plan.currency],
    ['Mode', modeLabel],
    ['Preset', `${plan.preset} Build`],
    ['Holders', String(plan.holderCount)],
    ['Developer buy', `${plan.developerBuy}%`],
    ['Holders buy', `${plan.holdersBuy}%`],
    [
      'Supply buy',
      estimate.allocation === null ? '—' : `${estimate.allocation}%`,
    ],
    ['Buy delay', seconds(plan.timing?.buyDelayMs)],
    ['Initial buy delay', seconds(plan.timing?.initialBuyDelayMs)],
    ['Scheduled', plan.scheduled ? 'Yes' : 'No'],
    ['Est. funding', `${estimate.scenarioTotal} ${plan.currency}`],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="launch-setup-dialog">
        <DialogTitle>Launch Setup</DialogTitle>
        <div className="launch-setup-token">
          <span className="launch-setup-avatar">
            {plan.ticker.slice(0, 2) || 'PF'}
          </span>
          <span>
            <strong>${plan.ticker || 'TOKEN'}</strong>{' '}
            <small>{plan.tokenName || 'Untitled'}</small>
          </span>
          <VenueMark name={plan.launchpad} size={18} />
        </div>
        <h3>Configuration</h3>
        <dl className="launch-setup-tiles">
          {tiles.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <DialogDescription>
          Review only. Continuing opens the funding plan; nothing is signed or
          submitted here.
        </DialogDescription>
        <div className="launch-setup-actions">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Back
          </Button>
          <Button className="create-main" onClick={onContinue}>
            Continue to funding
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
