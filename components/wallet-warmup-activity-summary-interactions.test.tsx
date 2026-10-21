// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WalletWarmupActivitySummary } from './wallet-warmup-activity-summary';
it('only navigates to recovery after an explicit click, with the exact row wallet', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetcher = vi.fn(),
    recover = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.appendChild(host);
  try {
    await act(async () =>
      root.render(
        <WalletWarmupActivitySummary
          onRecover={recover}
          rows={[
            {
              wallet: 'synthetic-wallet',
              completedCycles: 0,
              totalCycles: 2,
              buyTransactions: 1,
              sellTransactions: 0,
              transactionCount: 1,
              buyVolumeLamports: '100',
              sellVolumeLamports: '0',
              volumeLamports: '100',
              recoveryCount: 1,
              state: 'Recovery required',
            },
          ]}
        />,
      ),
    );
    expect(recover).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    const button = host.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe(
      'Recover saved approvals for synthetic-wallet',
    );
    await act(async () => button.click());
    expect(recover).toHaveBeenCalledExactlyOnceWith('synthetic-wallet');
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
