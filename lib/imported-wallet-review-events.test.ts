import { afterEach, expect, it, vi } from 'vitest';
import {
  requestImportedWalletReview,
  subscribeImportedWalletReview,
  IMPORTED_WALLET_REVIEW,
} from './imported-wallet-review-events';
import { supplyWallet } from '../test/supply-history-fixture';
const request = {
  projectId: 'p',
  revision: 2,
  mint: supplyWallet(9),
  wallet: supplyWallet(1),
  side: 'Sell' as const,
};
afterEach(() => vi.unstubAllGlobals());
it('routes only exact project revision and mint, with synchronous admission and cleanup', () => {
  vi.stubGlobal('window', new EventTarget());
  const receive = vi.fn(() => null);
  const stop = subscribeImportedWalletReview(request, receive);
  expect(requestImportedWalletReview(request)).toBeNull();
  for (const foreign of [
    { ...request, projectId: 'other' },
    { ...request, revision: 1 },
    { ...request, mint: supplyWallet(8) },
  ])
    expect(requestImportedWalletReview(foreign)).toContain('Open this token');
  expect(receive).toHaveBeenCalledTimes(1);
  stop();
  expect(requestImportedWalletReview(request)).toContain('Open this token');
  expect(receive).toHaveBeenCalledTimes(1);
});
it('rejects malformed addresses and sides and relays a blocked wallet admission', () => {
  vi.stubGlobal('window', new EventTarget());
  const receive = vi.fn(() => 'Save this public wallet first.');
  const stop = subscribeImportedWalletReview(request, receive);
  expect(requestImportedWalletReview(request)).toBe(
    'Save this public wallet first.',
  );
  for (const bad of [
    { ...request, wallet: 'bad' },
    { ...request, mint: 'bad' },
    { ...request, revision: 0 },
    { ...request, side: 'Transfer' },
  ])
    expect(requestImportedWalletReview(bad as typeof request)).toContain(
      'invalid',
    );
  window.dispatchEvent(
    new CustomEvent(IMPORTED_WALLET_REVIEW, {
      detail: { request: { ...request, wallet: null } },
    }),
  );
  expect(receive).toHaveBeenCalledTimes(1);
  stop();
});
