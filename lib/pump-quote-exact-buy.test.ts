import { expect, it } from 'vitest';
import { pumpQuoteBuyFixture } from '../test/pump-quote-buy-fixture';
import schema from './pump-quote-route-schema.json';
import {
  classifyWalletMovement,
  requireMovementClassification,
} from './wallet-movement-classification';
function fixture() {
  const tx = pumpQuoteBuyFixture();
  const base = tx.tokenChanges[0];
  const quote = tx.tokenChanges.find(
    (t) =>
      t.mint ===
      tx.movementInstructions![0].accounts![
        schema.exactQuote.accounts.indexOf('quote_mint')
      ],
  )!;
  const data = Buffer.alloc(25);
  Buffer.from(schema.exactQuote.discriminator, 'hex').copy(data);
  data.writeBigUInt64LE(-BigInt(quote.changeRaw) + 1n, 8);
  data.writeBigUInt64LE(BigInt(base.changeRaw) - 1n, 16);
  tx.movementInstructions![0].dataHex = data.toString('hex');
  return tx;
}
it('classifies quote-budget buys from exact executed output and fee-inclusive spending', () => {
  const tx = fixture(),
    base = tx.tokenChanges[0];
  const result = classifyWalletMovement(tx, base.mint);
  expect(result).toMatchObject({
    kind: 'buy',
    protocol: 'Pump.fun',
    quote: { scope: 'venue-transfer' },
  });
  expect(result.quote!.raw).toBe(
    (-BigInt(
      tx.tokenChanges.find((t) => t.mint === result.quote!.mint)!.changeRaw,
    )).toString(),
  );
  expect(result.reason).toContain('buy_exact_quote_in_v2');
  expect(result.reason).toContain('final wallet cost');
  expect(() =>
    requireMovementClassification(result, base.changeRaw),
  ).not.toThrow();
});
it.each([
  'budget',
  'minimum',
  'partial',
  'historical',
  'base-leg',
  'base-delta',
  'authority',
  'fee-overflow',
  'roles',
  'ancestry',
] as const)('rejects contradictory exact quote %s evidence', (mutation) => {
  const tx = fixture(),
    base = tx.tokenChanges[0],
    root = tx.movementInstructions![0];
  const data = Buffer.from(root.dataHex!, 'hex');
  const leg = tx.movementInstructions!.find(
    (i) => i.type === 'transferChecked' && i.info?.mint === base.mint,
  )!;
  const fee = tx.movementInstructions!.find(
    (i) => i.type === 'transferChecked' && i.info?.mint !== base.mint,
  )!;
  if (mutation === 'budget') data.writeBigUInt64LE(1n, 8);
  if (mutation === 'minimum')
    data.writeBigUInt64LE(BigInt(base.changeRaw) + 1n, 16);
  if (mutation === 'partial') data[24] = 1;
  root.dataHex = data.toString('hex');
  if (mutation === 'historical') root.dataHex = root.dataHex!.slice(0, -2);
  if (mutation === 'base-leg') leg.info!.amount = '1';
  if (mutation === 'base-delta') base.changeRaw = '-1';
  if (mutation === 'authority') fee.info!.authority = base.mint;
  if (mutation === 'fee-overflow') fee.info!.amount = '18446744073709551615';
  if (mutation === 'roles') root.accounts![13] = base.mint;
  if (mutation === 'ancestry') delete leg.stackHeight;
  expect(classifyWalletMovement(tx, base.mint).kind).toBe('unknown');
});
