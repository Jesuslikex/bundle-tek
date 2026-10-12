import { beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { directMovementFixture } from '../test/direct-movement-fixture';
import type { PoolTradeMovementContext } from './pool-trade-movement';
import { requirePoolTradeMovement } from './pool-trade-movement';
const mocks = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('./tracked-wallet-transaction', () => ({
  observeTrackedTransaction: mocks.observe,
}));
import { observePoolTradeMovement } from './pool-trade-movement-server';
const signature = bs58.encode(new Uint8Array(64).fill(1));
const tx = () => ({
  ...directMovementFixture(0, 0),
  signature,
  source: 'rpc.fixture.test',
});
function context(): PoolTradeMovementContext {
  const t = tx();
  return {
    projectId: crypto.randomUUID(),
    revision: 1,
    pool: t.tokenChanges[0].mint,
    mint: t.tokenChanges[1].mint,
    decimals: 6,
    tapeObservedAt: new Date().toISOString(),
    trade: {
      id: 'fixture-trade',
      sender: t.address,
      transaction: signature,
      block: 100,
      timestamp: new Date().toISOString(),
      side: 'Buy',
      tokenAmount: '0.001',
      quoteAmount: '0.001',
      priceUsd: '1',
      volumeUsd: '1',
    },
  };
}
beforeEach(() => {
  mocks.observe.mockReset();
  mocks.observe.mockResolvedValue(tx());
});
it('checks the retained wallet/signature and reports independently decoded direction and chain context', async () => {
  const c = context(),
    result = await observePoolTradeMovement(c, AbortSignal.timeout(1000));
  expect(mocks.observe).toHaveBeenCalledWith(
    c.trade.sender,
    'mainnet',
    c.trade.transaction,
    expect.any(AbortSignal),
  );
  expect(result).toMatchObject({
    sideAgrees: true,
    blockAgrees: true,
    classification: { kind: 'buy', protocol: 'PumpSwap' },
    tokenChange: { changeRaw: '1000', decimals: 6 },
    executionAllowed: false,
  });
  c.trade.side = 'Sell';
  c.trade.block = 101;
  expect(
    await observePoolTradeMovement(c, AbortSignal.timeout(1000)),
  ).toMatchObject({
    sideAgrees: false,
    blockAgrees: false,
    providerSide: 'Sell',
    slot: 100,
  });
});
it('does not turn provider labels or failed/incomplete transaction metadata into verified trades', async () => {
  const c = context();
  for (const patch of [
    { failed: true },
    { walletSigner: false },
    { tokensComplete: false },
    { movementInstructions: undefined },
  ]) {
    mocks.observe.mockResolvedValue({ ...tx(), ...patch });
    expect(
      await observePoolTradeMovement(c, AbortSignal.timeout(1000)),
    ).toMatchObject({ sideAgrees: null, classification: { kind: 'unknown' } });
  }
});
it('rejects substituted identities, precision and forged classification context', async () => {
  const c = context();
  for (const patch of [
    { address: c.pool },
    { signature: bs58.encode(new Uint8Array(64).fill(2)) },
    { network: 'devnet' },
  ]) {
    mocks.observe.mockResolvedValue({ ...tx(), ...patch });
    await expect(
      observePoolTradeMovement(c, AbortSignal.timeout(1000)),
    ).rejects.toThrow('identity');
  }
  mocks.observe.mockResolvedValue(tx());
  const result = await observePoolTradeMovement(c, AbortSignal.timeout(1000));
  for (const altered of [
    { ...result, sideAgrees: false },
    { ...result, walletSigner: false },
    { ...result, tokenChange: null },
    { ...result, executionAllowed: true },
  ])
    expect(() =>
      requirePoolTradeMovement(altered as typeof result, c),
    ).toThrow();
  mocks.observe.mockResolvedValue(null);
  await expect(
    observePoolTradeMovement(c, AbortSignal.timeout(1000)),
  ).rejects.toThrow('unavailable');
});
