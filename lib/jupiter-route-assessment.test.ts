import { expect, it } from 'vitest';
import { routeOrder, routeReview } from '../test/jupiter-route-fixture';
import { assessJupiterRoute } from './jupiter-route-assessment';
import schema from './jupiter-route-schema.json';
it('matches V2 ordinary and shared layouts with declared capped fees and rejects changed fees, native receivers and excess fees', () => {
  for (const shared of [false, true]) {
    const order = {
      ...routeOrder,
      platformFee: { bps: 2, mint: routeOrder.inputMint },
    };
    expect(
      assessJupiterRoute(routeReview({ v2: true, shared, fee: 2 }), order),
    ).toMatchObject({
      status: 'Matched fields',
      decoded: { v2: true, platformFeeBps: 2, positiveSlippageBps: 0 },
      checks: { inputMint: true, tokenPrograms: true, platformFee: true },
    });
    expect(
      assessJupiterRoute(routeReview({ v2: true, shared, fee: 3 }), order)
        .status,
    ).toBe('Mismatch');
    expect(
      assessJupiterRoute(routeReview({ v2: true, shared, fee: 51 }), {
        ...order,
        platformFee: { bps: 51, mint: order.inputMint },
      }).status,
    ).toBe('Mismatch');
    expect(
      assessJupiterRoute(
        routeReview({ v2: true, shared, positiveFee: 1 }),
        routeOrder,
      ).status,
    ).toBe('Mismatch');
    const wrongProgram = routeReview({ v2: true, shared });
    wrongProgram.instructions[0].accounts[shared ? 8 : 5].address =
      routeOrder.inputMint;
    expect(assessJupiterRoute(wrongProgram, routeOrder).status).toBe(
      'Mismatch',
    );
  }
  const nativeReceiver = routeReview({ v2: true, shared: false });
  nativeReceiver.instructions[0].accounts[7].address =
    routeOrder.preparation.wallet;
  expect(assessJupiterRoute(nativeReceiver, routeOrder).status).toBe(
    'Mismatch',
  );
});
it('rejects truncated V2 headers, malformed candidate fields and split basis point totals', () => {
  for (const alter of [
    (bytes: Uint8Array) => bytes.slice(0, 20),
    (bytes: Uint8Array) => Uint8Array.from([...bytes, 0]),
    (bytes: Uint8Array) => {
      bytes[bytes.length - 4] = 15;
      return bytes;
    },
  ])
    expect(
      assessJupiterRoute(routeReview({ v2: true, alter }), routeOrder).status,
    ).toBe('Mismatch');
  const variant = schema.variants.findIndex((v) => v.name === 'DynamicV1');
  for (const variantData of [
    [33, 0, 0, 0],
    [1, 0, 0, 0, 255],
    [1, 0, 0, 0, 0, ...Array(8).fill(0), 2, 0],
  ])
    expect(
      assessJupiterRoute(
        routeReview({ v2: true, variant, variantData }),
        routeOrder,
      ).status,
    ).toBe('Mismatch');
});
it('compares exact shared-route input/output/mints/wallet without claiming swap clearance', () => {
  const result = assessJupiterRoute(routeReview(), routeOrder);
  expect(result).toMatchObject({
    status: 'Matched fields',
    instructionsVerified: false,
    executionAllowed: false,
    decoded: {
      kind: 'sharedAccountsRoute',
      inAmountRaw: '1000000',
      quotedOutRaw: '1000',
      minimumOutLowerBoundRaw: '995',
      steps: [
        { venue: 'Raydium', percent: 100, inputIndex: 0, outputIndex: 1 },
      ],
    },
    checks: {
      inputAmount: true,
      quotedOutput: true,
      minimumOutput: true,
      walletAuthority: true,
      inputMint: true,
      outputMint: true,
    },
  });
  expect(
    assessJupiterRoute(routeReview({ shared: false }), routeOrder),
  ).toMatchObject({
    status: 'Matched fields',
    checks: { inputMint: null },
    decoded: { kind: 'route', inputMint: null },
  });
  const maximum = '18446744073709551615';
  expect(
    assessJupiterRoute(routeReview({ amount: BigInt(maximum) }), {
      ...routeOrder,
      inAmount: maximum,
    }).decoded!.inAmountRaw,
  ).toBe(maximum);
});
it.each(schema.variants.map((variant, index) => ({ ...variant, index })))(
  'decodes the pinned $name exact-input venue layout',
  (variant) => {
    const field = (type: string): number[] => {
      if (type === 'u128') return Array(16).fill(0);
      if (type === 'u64') return Array(8).fill(0);
      if (
        type === 'u32' ||
        type === 'bytes' ||
        type === 'RemainingAccountsInfo'
      )
        return Array(4).fill(0);
      if (type.startsWith('Array:')) {
        const [, element, length] = type.split(':');
        return Array.from({ length: Number(length) }, () =>
          field(element),
        ).flat();
      }
      if (type.startsWith('VecCandidateSwap'))
        return [
          1,
          0,
          0,
          0,
          0,
          ...Array(9).fill(0),
          ...(type === 'VecCandidateSwapWithBps' ? [16, 39, 0, 0] : []),
        ];
      return [0];
    };
    const data = variant.fields.flatMap(field);
    for (const v2 of [false, true]) {
      const result = assessJupiterRoute(
        routeReview({ v2, variant: variant.index, variantData: data }),
        routeOrder,
      );
      expect(result.status).toBe('Matched fields');
      expect(result.decoded?.steps[0].venue).toBe(variant.name);
    }
  },
);
it('decodes a connected multi-hop split and rejects a disconnected or cyclic graph', () => {
  const alter = (steps: number[]) => (bytes: Uint8Array) =>
    Uint8Array.from([
      ...bytes.slice(0, 9),
      steps.length / 4,
      0,
      0,
      0,
      ...steps,
      ...bytes.slice(-19),
    ]);
  expect(
    assessJupiterRoute(
      routeReview({
        alter: alter([7, 60, 0, 1, 7, 40, 0, 2, 7, 100, 1, 3, 7, 100, 2, 3]),
      }),
      routeOrder,
    ),
  ).toMatchObject({ status: 'Matched fields', checks: { routeGraph: true } });
  expect(
    assessJupiterRoute(
      routeReview({ alter: alter([7, 100, 0, 2, 7, 100, 2, 1]) }),
      routeOrder,
    ).status,
  ).toBe('Matched fields');
  for (const steps of [
    [7, 100, 0, 1, 7, 100, 2, 3],
    [7, 100, 0, 1, 7, 100, 1, 0],
    [7, 90, 0, 1],
    [7, 100, 0, 1, 7, 100, 1, 2, 7, 100, 1, 3],
  ])
    expect(
      assessJupiterRoute(routeReview({ alter: alter(steps) }), routeOrder)
        .status,
    ).toBe('Mismatch');
});
it('rejects malformed new optional and remaining-account layouts', () => {
  const variant = schema.variants.findIndex(
    (v) => v.name === 'WhirlpoolSwapV2',
  );
  for (const variantData of [
    [1, 2],
    [1, 1, 33, 0, 0, 0],
    [1, 1, 1, 0, 0, 0, 9, 1],
  ])
    expect(
      assessJupiterRoute(routeReview({ variant, variantData }), routeOrder)
        .status,
    ).toBe('Mismatch');
});
it('reports quote/amount/protection/mint/authority/fee mismatches explicitly', () => {
  for (const [options, order] of [
    [{ amount: 1000001n }, routeOrder],
    [{ output: 1001n }, routeOrder],
    [{ slippage: 51 }, routeOrder],
    [{ fee: 1 }, routeOrder],
    [{}, { ...routeOrder, minimumOutAmount: '996' }],
    [{}, { ...routeOrder, inputMint: routeOrder.outputMint }],
    [{}, { ...routeOrder, outputMint: routeOrder.inputMint }],
    [{}, { ...routeOrder, preparation: { wallet: routeOrder.outputMint } }],
  ] as const)
    expect(assessJupiterRoute(routeReview(options), order).status).toBe(
      'Mismatch',
    );
  const missingAuthority = routeReview();
  missingAuthority.instructions[0].accounts[2].signer = false;
  expect(
    assessJupiterRoute(missingAuthority, routeOrder).checks.walletAuthority,
  ).toBe(false);
  const unresolved = routeReview();
  unresolved.instructions[0].accounts[7].address = '';
  expect(assessJupiterRoute(unresolved, routeOrder).status).toBe('Unavailable');
});
it('holds unknown layouts/venues and rejects malformed complete supported layouts', () => {
  for (const options of [
    { variant: 255 },
    { unknownProgram: true },
    {
      alter: (bytes: Uint8Array) => {
        bytes[0] = 0;
        return bytes;
      },
    },
  ])
    expect(assessJupiterRoute(routeReview(options), routeOrder).status).toBe(
      'Unavailable',
    );
  for (const options of [
    { alter: (bytes: Uint8Array) => bytes.slice(0, -1) },
    { alter: (bytes: Uint8Array) => Uint8Array.from([...bytes, 0]) },
    { variant: 8, variantData: [2] },
    {
      alter: (bytes: Uint8Array) => {
        bytes[9] = 0;
        return bytes;
      },
    },
    { slippage: 10001 },
  ])
    expect(assessJupiterRoute(routeReview(options), routeOrder).status).toBe(
      'Mismatch',
    );
  expect(
    assessJupiterRoute(
      routeReview({ variant: 8, variantData: [1] }),
      routeOrder,
    ).status,
  ).toBe('Matched fields');
  const multiple = routeReview();
  multiple.instructions.push(multiple.instructions[0]);
  expect(assessJupiterRoute(multiple, routeOrder).status).toBe('Unavailable');
});
