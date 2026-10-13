import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  routeReview,
  routeOrder,
  routeWallet,
} from '../test/jupiter-route-fixture';
import {
  assessJupiterExactOutRoute,
  type JupiterExactOutOrder,
} from './jupiter-exact-out-assessment';
import {
  assessJupiterRoute,
  decodeJupiterExactOutRoute,
  decodeJupiterRoute,
} from './jupiter-route-assessment';

const order: JupiterExactOutOrder = {
  swapMode: 'ExactOut',
  wallet: routeWallet,
  inputMint: routeOrder.inputMint,
  outputMint: routeOrder.outputMint,
  quotedInputRaw: '1000000',
  outputTargetRaw: '1000',
  maximumInputRaw: '1005000',
  reviewedInputBudgetRaw: '2000000',
  slippageBps: 50,
};
function review(
  input = 1000000n,
  output = 1000n,
  options: Parameters<typeof routeReview>[0] = {},
) {
  return routeReview({
    ...options,
    amount: input,
    output,
    accountIndices: [5, 6, 0, 1, 1, 2, 2, 3, 4, 6, 6, 6, 6],
    alter: (bytes) => {
      const result = Uint8Array.from(bytes);
      result.set(
        createHash('sha256')
          .update('global:shared_accounts_exact_out_route')
          .digest()
          .subarray(0, 8),
      );
      const view = new DataView(result.buffer),
        start = result.length - 19;
      view.setBigUint64(start, output, true);
      view.setBigUint64(start + 8, input, true);
      return options.alter?.(result) ?? result;
    },
  });
}
it('decodes the independently hashed shared ExactOut discriminator and output-first trailer', () => {
  const bytes = review().instructions[0].dataHex;
  expect(bytes.slice(0, 16)).toBe('b0d169a89a7d453e');
  expect(decodeJupiterExactOutRoute(bytes)).toMatchObject({
    kind: 'sharedAccountsExactOutRoute',
    outputTargetRaw: '1000',
    quotedInputRaw: '1000000',
    maximumInputUpperBoundRaw: '1005000',
  });
  expect(assessJupiterExactOutRoute(review(), order)).toMatchObject({
    status: 'Matched fields',
    executionAllowed: false,
    instructionsVerified: false,
  });
});
it('keeps ExactOut instructions out of existing ExactIn assessment', () => {
  expect(decodeJupiterRoute(review().instructions[0].dataHex)).toBeNull();
  expect(assessJupiterRoute(review(), routeOrder).status).toBe('Unavailable');
  expect(assessJupiterExactOutRoute(routeReview(), order).status).toBe(
    'Unavailable',
  );
});
it('uses integer ceilings without rounding a one-atom maximum input downward', () => {
  expect(
    assessJupiterExactOutRoute(review(1n), {
      ...order,
      quotedInputRaw: '1',
      maximumInputRaw: '2',
    }).status,
  ).toBe('Matched fields');
  expect(
    assessJupiterExactOutRoute(review(1n), {
      ...order,
      quotedInputRaw: '1',
      maximumInputRaw: '1',
    }),
  ).toMatchObject({ status: 'Mismatch', checks: { maximumInput: false } });
  expect(
    assessJupiterExactOutRoute(review((1n << 64n) - 1n), {
      ...order,
      quotedInputRaw: '18446744073709551615',
      maximumInputRaw: '18446744073709551615',
      reviewedInputBudgetRaw: '18446744073709551615',
    }).status,
  ).toBe('Mismatch');
});
it('rejects changed input, output, slippage, budgets and unrequested fees', () => {
  for (const changed of [
    review(999999n),
    review(1000000n, 1001n),
    review(1000000n, 1000n, { slippage: 51 }),
    review(1000000n, 1000n, { fee: 1 }),
  ])
    expect(assessJupiterExactOutRoute(changed, order).status).toBe('Mismatch');
  for (const changes of [
    { maximumInputRaw: '1004999' },
    { reviewedInputBudgetRaw: '1004999' },
    { quotedInputRaw: '01' },
    { outputTargetRaw: '0' },
    { slippageBps: NaN },
    { swapMode: 'ExactIn' },
    { wallet: 'bad' },
    { outputMint: order.inputMint },
  ])
    expect(
      assessJupiterExactOutRoute(review(), {
        ...order,
        ...changes,
      } as JupiterExactOutOrder).status,
    ).toBe('Mismatch');
});
it('rejects wrong authority, missing signer, mints, writability, programs and unresolved accounts', () => {
  for (const mutate of [
    (r: ReturnType<typeof review>) => {
      r.instructions[0].accounts[2].address = order.inputMint;
    },
    (r: ReturnType<typeof review>) => {
      r.instructions[0].accounts[2].signer = false;
    },
    (r: ReturnType<typeof review>) => {
      r.instructions[0].accounts[3].writable = false;
    },
    (r: ReturnType<typeof review>) => {
      r.instructions[0].accounts[6].writable = false;
    },
    (r: ReturnType<typeof review>) => {
      r.instructions[0].accounts[7].address = order.outputMint;
    },
    (r: ReturnType<typeof review>) => {
      r.instructions[0].accounts[8].address = order.inputMint;
    },
    (r: ReturnType<typeof review>) => {
      r.instructions[0].accounts[0].address = order.inputMint;
    },
    (r: ReturnType<typeof review>) => {
      r.instructions[0].accounts[10].address = order.inputMint;
    },
    (r: ReturnType<typeof review>) => {
      r.instructions[0].accounts[12].address = order.inputMint;
    },
  ]) {
    const r = review();
    mutate(r);
    expect(assessJupiterExactOutRoute(r, order).status).toBe('Mismatch');
  }
  const unresolved = review();
  unresolved.instructions[0].accounts[8].address = '';
  expect(assessJupiterExactOutRoute(unresolved, order).status).toBe(
    'Unavailable',
  );
});
it('holds unsupported layouts and requires one complete resolved route', () => {
  expect(
    assessJupiterExactOutRoute(review(1000000n, 1000n, { variant: 255 }), order)
      .status,
  ).toBe('Unavailable');
  const multiple = review();
  multiple.instructions.push(multiple.instructions[0]);
  expect(assessJupiterExactOutRoute(multiple, order).status).toBe(
    'Unavailable',
  );
  const missing = review();
  missing.instructions[0].accounts.pop();
  expect(assessJupiterExactOutRoute(missing, order).status).toBe('Mismatch');
  for (const alter of [
    (b: Uint8Array) => b.slice(0, -1),
    (b: Uint8Array) => Uint8Array.from([...b, 0]),
    (b: Uint8Array) => {
      b[b.length - 20] = 0;
      return b;
    },
  ])
    expect(
      assessJupiterExactOutRoute(review(1000000n, 1000n, { alter }), order)
        .status,
    ).toBe('Mismatch');
});
