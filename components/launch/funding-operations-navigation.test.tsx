// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';

vi.mock('@/components/wallet-console', () => ({ WalletConsole: () => null }));
vi.mock('./funding-planner', () => ({ FundingPlanner: () => null }));
import { FundingForm } from './funding-form';

it('opens the Operations preview only for non-Solana funding, without executing a funding action', () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const openOperations = vi.fn();
  const next = vi.fn();
  const props = {
    estimate: {
      scenarioTotal: '0',
      supplyCost: '0',
      walletReserve: '0',
      maximumExposure: '0',
    },
    validationError: null,
    onChange: vi.fn(),
    onNext: next,
    onOpenOperations: openOperations,
  };
  try {
    act(() =>
      root.render(
        <FundingForm
          {...props}
          plan={{ ...DEFAULT_LAUNCH_PLAN, chain: 'Base' }}
        />,
      ),
    );
    const button = [...host.querySelectorAll('button')].find(
      (item) => item.textContent === 'Open Operations preview',
    );
    expect(button).toBeDefined();
    act(() => button!.click());
    expect(openOperations).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    act(() =>
      root.render(<FundingForm {...props} plan={DEFAULT_LAUNCH_PLAN} />),
    );
    expect(host.textContent).not.toContain('Open Operations preview');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
