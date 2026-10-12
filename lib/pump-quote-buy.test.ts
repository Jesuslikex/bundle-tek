import { expect, it } from 'vitest';
import { pumpQuoteBuyFixture } from '../test/pump-quote-buy-fixture';
import {
  classifyWalletMovement,
  requireMovementClassification,
} from './wallet-movement-classification';
const classify = (tx = pumpQuoteBuyFixture()) =>
  classifyWalletMovement(tx, tx.tokenChanges[0].mint);
it('attributes a fixed-amount buy and all observed quote/fee payments within the maximum', () => {
  const tx = pumpQuoteBuyFixture(),
    c = classify(tx);
  expect(c).toMatchObject({
    kind: 'buy',
    basis: 'pump-quote-and-token-transfers',
    protocol: 'Pump.fun',
    quote: { scope: 'venue-transfer' },
  });
  expect(c.quote!.raw).toBe(
    (-BigInt(
      tx.tokenChanges.find((t) => t.mint === c.quote!.mint)!.changeRaw,
    )).toString(),
  );
  expect(c.reason).toContain('final wallet cost');
  expect(() =>
    requireMovementClassification(c, tx.tokenChanges[0].changeRaw),
  ).not.toThrow();
});
it.each([
  'partial',
  'limit',
  'base-amount',
  'base-authority',
  'quote-authority',
  'no-depth',
  'missing-payment',
] as const)('rejects %s buy evidence', (mutation) => {
  const tx = pumpQuoteBuyFixture(),
    root = tx.movementInstructions![0];
  const baseLeg = tx.movementInstructions!.find(
    (i) =>
      i.type === 'transferChecked' && i.info?.mint === tx.tokenChanges[0].mint,
  )!;
  const quoteLeg = tx.movementInstructions!.find(
    (i) =>
      i.type === 'transferChecked' && i.info?.mint !== tx.tokenChanges[0].mint,
  )!;
  if (mutation === 'partial') root.dataHex = root.dataHex!.slice(0, -2) + '01';
  if (mutation === 'limit')
    root.dataHex = root.dataHex!.slice(0, 32) + '0000000000000000' + '00';
  if (mutation === 'base-amount') baseLeg.info!.amount = '1';
  if (mutation === 'base-authority') baseLeg.info!.authority = tx.address;
  if (mutation === 'quote-authority')
    quoteLeg.info!.authority = root.accounts![10];
  if (mutation === 'no-depth') delete baseLeg.stackHeight;
  if (mutation === 'missing-payment')
    quoteLeg.info!.mint = tx.tokenChanges[0].mint;
  expect(classify(tx).kind).toBe('unknown');
});
