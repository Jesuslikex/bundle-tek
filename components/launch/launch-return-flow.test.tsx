// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { EMPTY_IDENTITY } from '@/lib/workspace-project';
import { FundingForm } from './funding-form';
import { LaunchMetadataReview } from './launch-metadata-review';
import { useLaunchReviewReturn } from './use-launch-review-return';
import { hasLaunchMetadataReview } from '@/lib/launch-review-availability';

vi.mock('@/components/wallet-console', () => ({ WalletConsole: () => null }));
vi.mock('./funding-planner', () => ({ FundingPlanner: () => null }));
vi.mock('./pump-launch-history', () => ({ PumpLaunchHistory: () => null }));

function Flow() {
  const [view, setView] = useState('chain');
  const openReview = useLaunchReviewReturn(view, setView);
  const plan = { ...DEFAULT_LAUNCH_PLAN, tokenName: 'Example', ticker: 'EX' };
  if (view === 'chain')
    return <button onClick={() => setView('token')}>Choose chain</button>;
  if (view === 'token')
    return (
      <>
        <LaunchMetadataReview
          plan={plan}
          identity={EMPTY_IDENTITY}
          project={null}
        />
        <button onClick={() => setView('launch')}>
          Continue to launch settings
        </button>
      </>
    );
  if (view === 'launch')
    return (
      <>
        <button onClick={openReview}>Open launch review</button>
        <button onClick={() => setView('funding')}>Review funding</button>
      </>
    );
  return (
    <FundingForm
      plan={plan}
      estimate={{
        scenarioTotal: '0',
        supplyCost: '0',
        walletReserve: '0',
        maximumExposure: '0',
      }}
      validationError={null}
      onChange={() => {}}
      onNext={() => {}}
      onOpenLaunchReview={openReview}
    />
  );
}

afterEach(() => vi.unstubAllGlobals());
it('only offers review navigation for supported launch venues', () => {
  expect(
    hasLaunchMetadataReview({ chain: 'Solana', launchpad: 'PumpFun' }),
  ).toBe(true);
  expect(
    hasLaunchMetadataReview({ chain: 'Solana', launchpad: 'StonkFun' }),
  ).toBe(true);
  expect(hasLaunchMetadataReview({ chain: 'Solana', launchpad: 'Bags' })).toBe(
    false,
  );
  expect(hasLaunchMetadataReview({ chain: 'Base', launchpad: 'PumpFun' })).toBe(
    false,
  );
});
it('returns from settings and funding to the opened metadata review without publishing', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const click = (label: string) =>
    act(() => {
      const button = [...host.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === label,
      );
      expect(button).toBeDefined();
      button!.click();
    });
  try {
    act(() => root.render(<Flow />));
    click('Choose chain');
    click('Continue to launch settings');
    click('Open launch review');
    expect(
      host.querySelector<HTMLDetailsElement>('details.metadata-review')?.open,
    ).toBe(true);
    expect(document.activeElement?.tagName).toBe('SUMMARY');
    expect(host.textContent).toContain('Save your active project');
    click('Continue to launch settings');
    click('Review funding');
    click('Open launch review');
    expect(
      host.querySelector<HTMLDetailsElement>('details.metadata-review')?.open,
    ).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
