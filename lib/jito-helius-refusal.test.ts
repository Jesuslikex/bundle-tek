import { expect, it } from 'vitest';
import { classifyJitoHeliusRefusal } from './jito-helius-refusal';
it('classifies documented HTTP and JSON-RPC rate limits without exposing text', () => {
  for (const [code, status] of [
    [429, 200],
    [-32005, 200],
    [-32005, 429],
  ]) {
    const r = classifyJitoHeliusRefusal(
      { error: { code, message: 'Too many requests secret-marker' } },
      status,
    );
    expect(r).toMatchObject({
      rateLimited: true,
      category: 'rate-limit',
      codes: [code],
    });
    expect(JSON.stringify(r)).not.toContain('secret-marker');
  }
});
it('does not confuse a lagging node with a rate limit; recognizes batch and quota refusals', () => {
  expect(
    classifyJitoHeliusRefusal(
      { error: { code: -32005, message: 'Node is behind by 30 slots' } },
      200,
    ).rateLimited,
  ).toBe(false);
  expect(
    classifyJitoHeliusRefusal(
      [
        { result: 1 },
        { error: { code: -32005, message: 'Rate limit exceeded' } },
      ],
      200,
    ).rateLimited,
  ).toBe(true);
  expect(
    classifyJitoHeliusRefusal(
      { error: { code: 429, message: 'Monthly credits exhausted' } },
      429,
    ),
  ).toMatchObject({ rateLimited: true, category: 'credit-quota' });
  expect(classifyJitoHeliusRefusal(null, 429)).toMatchObject({
    rateLimited: true,
    category: 'rate-limit',
  });
});
it('handles lossless wire BigInts and never invokes error getters', () => {
  expect(
    classifyJitoHeliusRefusal(
      { error: { code: -32005n, message: 'Too many requests' } },
      200,
    ).rateLimited,
  ).toBe(true);
  let called = false;
  const row = Object.defineProperty({}, 'error', {
    get() {
      called = true;
      throw Error('getter');
    },
  });
  expect(classifyJitoHeliusRefusal(row, 200).rateLimited).toBe(false);
  expect(called).toBe(false);
});
