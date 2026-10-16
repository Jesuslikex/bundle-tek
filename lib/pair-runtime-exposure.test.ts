import { expect, it } from 'vitest';
import { assertPairRuntimeWritableAccount } from './pair-runtime-exposure';
const SYSTEM = '11111111111111111111111111111111';
const account = (
  owner = SYSTEM,
  size = 0,
  executable = false,
  lamports = '9007199254740993',
) => ({
  owner,
  executable,
  lamports,
  data: [Buffer.alloc(size).toString('base64'), 'base64'],
});
it.each([
  ['system-data', account(SYSTEM, 80), 'systemDataBytes', '80'],
  [
    'stake-owner',
    account('Stake11111111111111111111111111111111111111', 80),
    'blockedOwner',
    'true',
  ],
  ['executable', account(SYSTEM, 0, true), 'executable', 'true'],
] as const)(
  'retains the same %s refusal with exact private context',
  (_label, raw, field, value) => {
    let error: Error & { pairDiagnostic?: Record<string, unknown> };
    try {
      assertPairRuntimeWritableAccount(raw, {
        address: SYSTEM,
        phase: 'after-inventory',
        slot: 123,
        before: account(),
      });
      throw Error('Accepted');
    } catch (caught) {
      error = caught as typeof error;
    }
    expect(error.message).toBe(
      'Pair runtime exposes unsupported writable custody or executable state.',
    );
    expect(error.pairDiagnostic).toMatchObject({
      check: 'writable-runtime-state',
      accountAddress: SYSTEM,
      observationPhase: 'after-inventory',
      contextSlot: 123,
    });
    expect(error.pairDiagnostic!.comparisons).toContainEqual({
      field,
      before: field === 'systemDataBytes' ? '0' : 'false',
      after: value,
    });
    expect(error.pairDiagnostic!.comparisons).toContainEqual({
      field: 'priorLamports',
      before: '9007199254740993',
      after: '9007199254740993',
    });
    expect(JSON.stringify(error)).toBe('{}');
  },
);
it('marks unavailable prior state explicitly and preserves empty-system/token account acceptance', () => {
  expect(() => assertPairRuntimeWritableAccount(null)).not.toThrow();
  expect(() => assertPairRuntimeWritableAccount(account())).not.toThrow();
  expect(() =>
    assertPairRuntimeWritableAccount(
      account('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 165),
    ),
  ).not.toThrow();
  try {
    assertPairRuntimeWritableAccount(account(SYSTEM, 1));
  } catch (error) {
    expect(
      (error as { pairDiagnostic: { comparisons: unknown[] } }).pairDiagnostic
        .comparisons,
    ).toContainEqual({
      field: 'priorOwner',
      before: '<unavailable>',
      after: SYSTEM,
    });
  }
});
