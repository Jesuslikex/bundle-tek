import { expect, it } from 'vitest';
import { poolTradeMovementError } from './pool-trade-movement-error';
it('provides safe account, identity and metadata explanations while keeping provider payloads private', () => {
  expect(
    poolTradeMovementError(
      new Error('Program missing from transaction accounts.'),
    ).reason,
  ).toBe('account-mismatch');
  expect(
    poolTradeMovementError(new Error('Transaction mint precision differs.'))
      .reason,
  ).toBe('context-mismatch');
  expect(
    poolTradeMovementError(new Error('Invalid transaction integer.')).reason,
  ).toBe('incomplete-metadata');
  expect(
    poolTradeMovementError(new Error('Invalid balance provider response.'))
      .reason,
  ).toBe('provider-unavailable');
  expect(
    poolTradeMovementError(new Error('Balance response too large.')).reason,
  ).toBe('response-bound');
  const result = poolTradeMovementError(
    new Error('provider failed https://rpc.example/?api-key=fixture-secret'),
  );
  expect(result.reason).toBe('unavailable');
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
  expect(JSON.stringify(result)).not.toContain('rpc.example');
});
