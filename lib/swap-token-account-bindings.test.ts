import { expect, it, vi } from 'vitest';
import { assessJupiterRoute } from './jupiter-route-assessment';
import { readSwapTokenAccountBindings } from './swap-token-account-bindings';
import { routeOrder, routeReview } from '../test/jupiter-route-fixture';
import { tokenAccountFixture } from '../test/swap-token-account-fixture';
const route = assessJupiterRoute(routeReview(), routeOrder);
const response = (
  value: unknown[] = [
    tokenAccountFixture(),
    tokenAccountFixture(routeOrder.outputMint),
  ],
  slot = '102',
) => vi.fn(async () => ({ context: { slot }, value }));
it('binds both actual accounts to selected mints and wallet owner with bounded confirmed RPC provenance', async () => {
  const rpc = response();
  const bindings = await readSwapTokenAccountBindings(
    route,
    routeOrder,
    101,
    rpc,
  );
  expect(bindings).toMatchObject({ status: 'Matched bindings', slot: 102 });
  expect(bindings.accounts.map((a) => a.walletOwner)).toEqual([
    routeOrder.preparation.wallet,
    routeOrder.preparation.wallet,
  ]);
  expect(rpc.mock.calls).toEqual([
    [
      'getMultipleAccounts',
      [
        [route.decoded!.sourceAccount, route.decoded!.destinationAccount],
        { encoding: 'base64', commitment: 'confirmed', minContextSlot: 101 },
      ],
    ],
  ]);
  expect(bindings.limitations).toContain('not simulated post-state');
});
it('reports wrong mint, wallet, frozen state and non-token program as mismatches; missing accounts remain unavailable', async () => {
  for (const raw of [
    tokenAccountFixture(routeOrder.outputMint),
    tokenAccountFixture(routeOrder.inputMint, routeOrder.outputMint),
    tokenAccountFixture(routeOrder.inputMint, undefined, 2),
    tokenAccountFixture(routeOrder.inputMint, undefined, 0),
    { ...tokenAccountFixture(), owner: '11111111111111111111111111111111' },
  ]) {
    const result = await readSwapTokenAccountBindings(
      route,
      routeOrder,
      101,
      response([raw, tokenAccountFixture(routeOrder.outputMint)]),
    );
    expect(result.status).toBe('Mismatch');
  }
  for (const raw of [null]) {
    expect(
      (
        await readSwapTokenAccountBindings(
          route,
          routeOrder,
          101,
          response([raw, tokenAccountFixture(routeOrder.outputMint)]),
        )
      ).status,
    ).toBe('Unavailable');
  }
  const rpc = response();
  expect(
    (
      await readSwapTokenAccountBindings(
        assessJupiterRoute(routeReview({ variant: 255 }), routeOrder),
        routeOrder,
        101,
        rpc,
      )
    ).slot,
  ).toBe(102);
  expect(rpc).toHaveBeenCalled();
});
it('reads canonical Token-2022 base bindings without claiming independent mint-extension or signing clearance', async () => {
  const raw = {
    ...tokenAccountFixture(routeOrder.outputMint),
    owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  };
  const review = routeReview({ v2: true });
  review.instructions[0].accounts[9].address = raw.owner;
  const result = await readSwapTokenAccountBindings(
    assessJupiterRoute(review, routeOrder),
    routeOrder,
    101,
    response([tokenAccountFixture(), raw]),
  );
  expect(result.accounts[1]).toMatchObject({
    status: 'Matched bindings',
    tokenProgram: raw.owner,
    byteLength: 165,
  });
  expect(result.limitations).toContain(
    'mint extensions need separate fresh evidence',
  );
  expect(
    (
      await readSwapTokenAccountBindings(
        route,
        routeOrder,
        101,
        response([tokenAccountFixture(), raw]),
      )
    ).status,
  ).toBe('Mismatch');
});
it('rejects malformed binary layouts, option tags, account metadata and stale or distant contexts', async () => {
  const valid = tokenAccountFixture();
  const malformed = (offset: number) => {
    const bytes = Uint8Array.from(atob(valid.data[0]), (c) => c.charCodeAt(0));
    bytes[offset] = 3;
    return { ...valid, data: [btoa(String.fromCharCode(...bytes)), 'base64'] };
  };
  for (const raw of [
    { ...valid, executable: true },
    { ...valid, data: [valid.data[0].slice(1), 'base64'] },
    malformed(72),
    malformed(109),
    malformed(129),
    malformed(108),
    undefined,
  ])
    await expect(
      readSwapTokenAccountBindings(
        route,
        routeOrder,
        101,
        response([raw, valid]),
      ),
    ).rejects.toThrow();
  for (const slot of ['100', '134', '1e2', '9007199254740992'])
    await expect(
      readSwapTokenAccountBindings(
        route,
        routeOrder,
        101,
        response(undefined, slot),
      ),
    ).rejects.toThrow();
  await expect(
    readSwapTokenAccountBindings(route, routeOrder, 101, response([valid])),
  ).rejects.toThrow();
});
