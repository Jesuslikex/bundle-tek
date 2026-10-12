import { describe, it, expect } from 'vitest';
import {
  captureSupply,
  requireSupplyHistoryRow,
  supplyScopeId,
  canonicalSupplyScope,
  type SupplyHistoryRow,
} from './supply-history';
import { supplyScope, supplyFixture } from '../test/supply-history-fixture';
describe('immutable supply captures', () => {
  it('canonicalizes scopes independently of wallet order but changes identity with classification', async () => {
    expect(await supplyScopeId(supplyScope)).toBe(
      await supplyScopeId({
        ...supplyScope,
        wallets: supplyScope.wallets.toReversed(),
      }),
    );
    expect(await supplyScopeId(supplyScope)).not.toBe(
      await supplyScopeId(
        canonicalSupplyScope({
          ...supplyScope,
          wallets: supplyScope.wallets.map((w) => ({ ...w, group: 'pool' })),
        }),
      ),
    );
  });
  it('creates a silent baseline and exact increases and decreases, without inferring transactions', async () => {
    const scopeId = await supplyScopeId(supplyScope),
      first: SupplyHistoryRow = {
        id: 'first',
        sequence: 1,
        scopeId,
        document: captureSupply(supplyFixture(), supplyScope, 1, null),
      };
    expect(first.document.alerts).toEqual([]);
    const second = {
      id: 'second',
      sequence: 2,
      scopeId,
      document: captureSupply(supplyFixture(1), supplyScope, 2, first),
    };
    expect(second.document.alerts.map((a) => [a.direction, a.amount])).toEqual([
      ['decrease', '0.01'],
      ['increase', '0.005'],
    ]);
    expect(second.document.previousSequence).toBe(1);
    expect(requireSupplyHistoryRow(second, supplyScope, scopeId)).toBe(second);
    const corrupt = structuredClone(second);
    corrupt.document.alerts[0].raw = '999';
    expect(() =>
      requireSupplyHistoryRow(corrupt, supplyScope, scopeId),
    ).toThrow('units');
  });
  it('rejects mixed watchlists, overlapping observations and corrupted partitions', async () => {
    const scopeId = await supplyScopeId(supplyScope),
      first: SupplyHistoryRow = {
        id: 'first',
        sequence: 1,
        scopeId,
        document: captureSupply(supplyFixture(), supplyScope, 1, null),
      };
    expect(() => captureSupply(supplyFixture(), supplyScope, 1, first)).toThrow(
      'overlap',
    );
    const wrong = supplyFixture(1);
    wrong.wallets[0].group = 'pool';
    expect(() => captureSupply(wrong, supplyScope, 1, first)).toThrow('scope');
    const bad = supplyFixture(1);
    bad.parts.team.raw = '1';
    expect(() => captureSupply(bad, supplyScope, 1, first)).toThrow(
      'partition',
    );
  });
});
