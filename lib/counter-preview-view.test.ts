import { expect, it } from 'vitest';
import { counterPreviewUiFixture } from '../test/counter-preview-ui-fixture';
import {
  counterPreviewView,
  counterPreviewWallets,
} from './counter-preview-view';
it('selects only verified active wallets in the reviewed exclusions', () => {
  const f = counterPreviewUiFixture();
  expect(counterPreviewWallets(f.workspace, f.plan)).toEqual([
    {
      address: f.request.wallet,
      revision: 1,
      label: 'Synthetic preview wallet',
    },
  ]);
  f.workspace.wallets[0].archived = true;
  expect(counterPreviewWallets(f.workspace, f.plan)).toEqual([]);
});
it('refuses new proof exclusions, duplicate wallets and unavailable proof metadata', () => {
  const f = counterPreviewUiFixture();
  expect(() =>
    counterPreviewWallets({ ...f.workspace, proofs: undefined }, f.plan),
  ).toThrow();
  expect(() =>
    counterPreviewWallets(
      {
        ...f.workspace,
        wallets: [...f.workspace.wallets, f.workspace.wallets[0]],
      },
      f.plan,
    ),
  ).toThrow();
  f.plan.rules.ignoredWallets = [];
  expect(() => counterPreviewWallets(f.workspace, f.plan)).toThrow(
    'exclusions changed',
  );
});
it('accepts an exact current summary while rejecting authority, swapped context, excess amounts and expiry', () => {
  const f = counterPreviewUiFixture();
  expect(counterPreviewView({ preview: f.preview }, f.plan, f.request)).toEqual(
    f.preview,
  );
  for (const patch of [
    { walletRevision: 2 },
    { decisionIdentity: 'changed' },
    { signingAllowed: true },
    { executionAllowed: true },
    { approvalAllowed: true },
    { reservationCreated: true },
    { sourceRevalidated: false },
    { sourceTradeCount: 0 },
    { sourceTradeCount: 2 },
    { sourceRecheckedAt: new Date(Date.now() - 31000).toISOString() },
    { sourceValidUntil: new Date(Date.now() - 1).toISOString() },
    { maximumQuoteInputRaw: '1006' },
    { actualSimulatedInputRaw: '1006' },
    { networkFeeLamports: '5001' },
    { tokenDecimals: 18 },
    { packetSha256: 'invalid' },
    { expiresAt: new Date(Date.now() - 1).toISOString() },
    { transaction: 'private-packet' },
  ])
    expect(() =>
      counterPreviewView(
        { preview: { ...f.preview, ...patch } },
        f.plan,
        f.request,
      ),
    ).toThrow();
});
