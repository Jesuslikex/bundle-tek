// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { OpenLaunchChartButton } from './open-launch-chart-button';
import { OPEN_IMPORTED_PROJECT_EVENT } from '@/lib/open-launch-chart';

it('imports the launched mint once and opens its Bundle workspace', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const project = {
    id: 'launched',
    archived: false,
    document: { token: { chain: 'Solana', address: 'Mint' } },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ projects: [] }))
    .mockResolvedValueOnce(Response.json({ project }));
  vi.stubGlobal('fetch', fetcher);
  const listener = vi.fn();
  window.addEventListener(OPEN_IMPORTED_PROJECT_EVENT, listener);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<OpenLaunchChartButton mint="Mint" />));
    await act(async () => host.querySelector('button')!.click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      action: 'import',
      chain: 'Solana',
      address: 'Mint',
    });
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      id: 'launched',
    });
    expect(host.textContent).toContain('Confirm any navigation prompt');
  } finally {
    act(() => root.unmount());
    host.remove();
    window.removeEventListener(OPEN_IMPORTED_PROJECT_EVENT, listener);
    vi.unstubAllGlobals();
  }
});
