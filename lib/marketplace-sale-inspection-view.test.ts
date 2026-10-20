import { expect, it } from 'vitest';
import { marketplaceSaleInspectionFixture } from '../test/marketplace-sale-inspection-fixture';
import { admitSaleInspection } from './marketplace-sale-inspection-view';
const now = Date.parse('2026-10-20T12:00:00.000Z');
it('admits the exact informational snapshot and its signed integer difference', () => {
  const f = marketplaceSaleInspectionFixture(now);
  expect(
    admitSaleInspection(
      { inspection: f.inspection },
      f.inventory,
      f.selection,
      now,
    ),
  ).toEqual(f.inspection);
});
it.each([
  'price',
  'revision',
  'address',
  'proof',
  'balance',
  'difference',
  'kind',
  'owner',
  'signing',
  'tokens',
  'extra',
  'floor',
  'span',
  'future',
  'expiry',
  'unbound-start',
])(
  'refuses changed %s rather than displaying an unbound account result',
  (change) => {
    const f = marketplaceSaleInspectionFixture(now),
      v = structuredClone(f.inspection);
    if (change === 'price') v.selection.priceLamports = '1';
    if (change === 'revision') v.selection.walletRevision++;
    if (change === 'address') v.selection.address = f.fixture.b;
    if (change === 'proof') v.historicalControlProofAt = null;
    if (change === 'balance') v.historicalBalanceLamports = '0';
    if (change === 'difference') v.balanceDifferenceLamports = '0';
    if (change === 'kind') v.account.kind = 'unsupported-account';
    if (change === 'owner') v.account.owner = f.fixture.b;
    if (change === 'signing') Object.assign(v, { signingAllowed: true });
    if (change === 'tokens') Object.assign(v, { tokenInventoryChecked: true });
    if (change === 'extra') Object.assign(v, { paymentAddress: f.fixture.b });
    if (change === 'floor') v.floorSlot = 102;
    if (change === 'span') v.finalSlot = 133;
    if (change === 'future') v.observedAt = new Date(now + 1).toISOString();
    if (change === 'expiry') v.expiresAt = new Date(now + 60001).toISOString();
    if (change === 'unbound-start') {
      v.startedAt = new Date(now - 1).toISOString();
      v.expiresAt = new Date(now + 59999).toISOString();
    }
    expect(() =>
      admitSaleInspection({ inspection: v }, f.inventory, f.selection, now),
    ).toThrow();
  },
);
it('admits genuine unsupported metadata and absent accounts with exact nulls', () => {
  const f = marketplaceSaleInspectionFixture(now);
  f.inspection.account.kind = 'unsupported-account';
  f.inspection.account.space = '80';
  expect(
    admitSaleInspection(
      { inspection: f.inspection },
      f.inventory,
      f.selection,
      now,
    ).account.kind,
  ).toBe('unsupported-account');
  f.inspection.account = {
    kind: 'absent',
    balanceLamports: '0',
    owner: null,
    executable: null,
    space: null,
  };
  f.inspection.balanceDifferenceLamports = '-1234567891';
  expect(
    admitSaleInspection(
      { inspection: f.inspection },
      f.inventory,
      f.selection,
      now,
    ).account.kind,
  ).toBe('absent');
  f.inspection.account.owner = '11111111111111111111111111111111';
  expect(() =>
    admitSaleInspection(
      { inspection: f.inspection },
      f.inventory,
      f.selection,
      now,
    ),
  ).toThrow();
});
it('refuses expiry and non-exact response envelopes', () => {
  const f = marketplaceSaleInspectionFixture(now);
  expect(() =>
    admitSaleInspection(
      { inspection: f.inspection },
      f.inventory,
      f.selection,
      now + 60000,
    ),
  ).toThrow();
  expect(() =>
    admitSaleInspection(
      { inspection: f.inspection, authorised: true },
      f.inventory,
      f.selection,
      now,
    ),
  ).toThrow();
});
