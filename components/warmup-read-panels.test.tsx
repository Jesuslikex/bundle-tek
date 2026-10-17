// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletWarmupPreflight } from './wallet-warmup-preflight';
import { WalletWarmupQuote } from './wallet-warmup-quote';

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

for (const panel of ['preflight', 'quote'] as const) {
  for (const body of ['<html>Service unavailable</html>', 'null']) {
    it(`${panel} shows a usable retry error for ${body === 'null' ? 'null' : 'HTML'} responses`, async () => {
      const fetcher = vi.fn(async () => new Response(body, { status: 502 }));
      vi.stubGlobal('fetch', fetcher);
      await act(async () =>
        root.render(
          panel === 'preflight' ? (
            <WalletWarmupPreflight id="saved-plan" revision={1} />
          ) : (
            <WalletWarmupQuote id="saved-plan" revision={1} cycles={1} />
          ),
        ),
      );
      await act(async () => container.querySelector('button')!.click());
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        panel === 'preflight'
          ? 'Warmup preflight unavailable. Try checking again.'
          : 'Warmup quote unavailable. Try quoting again.',
      );
      expect(container.textContent).not.toMatch(
        /Unexpected token|Cannot read|<html>/,
      );
      expect(container.querySelector('button')!.disabled).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector('[aria-label="Warmup swap quote"]'),
      ).toBeNull();
      expect(
        container.querySelector('[aria-label="Warmup preflight observations"]'),
      ).toBeNull();
    });
  }
}
