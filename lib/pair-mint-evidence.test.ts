import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { address, some } from '@solana/kit-v1';
import type { ExtensionArgs } from '@solana-program/token-2022';
import {
  importedPairQuoteFixture,
  pairQuoteMint,
  pairQuoteClock,
} from '../test/imported-pair-quote-fixture';
import {
  PAIR_CLOCK,
  readPairMintEvidence,
  assertSamePairMintEvidence,
  pairClockUnixTimestamp,
} from './pair-mint-evidence';
import {
  SWAP_TOKEN_2022,
  readSwapMintEvidence,
} from './swap-token-program-evidence';
let f: ReturnType<typeof importedPairQuoteFixture> | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
const setup = () => {
  const fixture = (f = importedPairQuoteFixture());
  const now = Math.floor(Date.now() / 1000) * 1000;
  fixture.clockState.unixTimestamp = String(now / 1000);
  const pair = {
    inputMint: fixture.baseMint,
    outputMint: fixture.asset.address,
  };
  return {
    fixture,
    now,
    pair,
    read: () => readPairMintEvidence(pair, 100, fixture.rpc, now),
  };
};
it('distinguishes bank mismatch from wall-clock staleness without exposing private diagnostics in JSON', () => {
  const now = 1792161668000;
  for (const [clockSlot, unix, expected] of [
    [
      101,
      String(now / 1000),
      { contextSlot: 100, clockSlot: 101, wallSkewMs: 0 },
    ],
    [
      100,
      String(now / 1000 - 31),
      { contextSlot: 100, clockSlot: 100, wallSkewMs: 31000 },
    ],
  ] as const) {
    try {
      pairClockUnixTimestamp(pairQuoteClock(clockSlot, unix), 100, now);
      throw Error('must reject incoherent or stale clock');
    } catch (error) {
      expect(error).toMatchObject({
        message: 'Pair chain clock is inconsistent or stale.',
        pairDiagnostic: { check: 'chain-clock', ...expected },
      });
      expect(Object.keys(error as object)).not.toContain('pairDiagnostic');
      expect(JSON.stringify(error)).not.toContain('clockSlot');
    }
  }
});
it('reads the captured actual TSLAX controls with a same-bank Clock while native signing remains restricted', async () => {
  const { fixture, read, pair } = setup();
  fixture.mints[1] = JSON.parse(
    readFileSync('test/tslax-mainnet-mint-20261015.json', 'utf8'),
  ).account;
  const evidence = await read();
  expect(evidence.mints[1]).toMatchObject({
    program: SWAP_TOKEN_2022,
    decimals: 8,
    amountPolicy: { kind: 'scaled-ui-v1' },
    issuerControls: [
      'freezable',
      'mintable',
      'pausable',
      'permanent-delegate',
      'transfer-hook-upgradable',
      'ui-multiplier-upgradable',
    ],
  });
  expect((fixture.rpc.mock.calls[0][1][0] as string[])[2]).toBe(PAIR_CLOCK);
  await expect(
    readSwapMintEvidence(pair, 100, async () => ({
      context: { slot: '101' },
      value: fixture.mints,
    })),
  ).rejects.toThrow();
});
it.each([
  {
    __kind: 'PausableConfig',
    authority: some(address('11111111111111111111111111111111')),
    paused: true,
  },
  { __kind: 'DefaultAccountState', state: 2 },
  {
    __kind: 'TransferHook',
    authority: address('11111111111111111111111111111111'),
    programId: address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
  },
  { __kind: 'NonTransferable' },
] satisfies ExtensionArgs[])(
  'rejects unsupported or obstructed policy $.__kind',
  async (extension) => {
    const { fixture, read } = setup();
    fixture.mints[1] = pairQuoteMint(8, SWAP_TOKEN_2022, [extension]);
    await expect(read()).rejects.toMatchObject({ name: 'PairMintPolicyError' });
  },
);
it.each(['stale', 'slot', 'owner', 'size'] as const)(
  'rejects %s chain-clock evidence',
  async (mode) => {
    const { fixture, read, now } = setup();
    fixture.rpc.mockResolvedValueOnce({
      context: { slot: '101' },
      value: [
        ...fixture.mints,
        {
          ...pairQuoteClock(
            mode === 'slot' ? 102 : 101,
            String(now / 1000 - (mode === 'stale' ? 31 : 0)),
          ),
          ...(mode === 'owner' ? { owner: SWAP_TOKEN_2022 } : {}),
          ...(mode === 'size' ? { data: ['AA==', 'base64'] } : {}),
        },
      ],
    });
    await expect(read()).rejects.toThrow();
  },
);
it.each(['padding', 'duplicate', 'metadata-mint'] as const)(
  'rejects noncanonical %s extension evidence',
  async (mode) => {
    const { fixture, read } = setup();
    const extension = { __kind: 'DefaultAccountState' as const, state: 1 };
    fixture.mints[1] = pairQuoteMint(
      8,
      SWAP_TOKEN_2022,
      mode === 'metadata-mint'
        ? [
            {
              __kind: 'TokenMetadata',
              updateAuthority: address('11111111111111111111111111111111'),
              mint: address(fixture.baseMint),
              name: 'Wrong identity',
              symbol: 'WRONG',
              uri: 'https://fixture.example',
              additionalMetadata: new Map(),
            },
          ]
        : mode === 'duplicate'
          ? [extension, extension]
          : [extension],
    );
    if (mode === 'padding') {
      const bytes = Uint8Array.from(atob(fixture.mints[1].data[0]), (c) =>
        c.charCodeAt(0),
      );
      bytes[82] = 1;
      fixture.mints[1].data[0] = btoa(String.fromCharCode(...bytes));
    }
    await expect(read()).rejects.toMatchObject({ name: 'PairMintPolicyError' });
  },
);
it('allows supply changes but rejects a changed authority or active scale', async () => {
  const { fixture, read, now } = setup();
  const before = await read();
  const bytes = Uint8Array.from(atob(fixture.mints[1].data[0]), (c) =>
    c.charCodeAt(0),
  );
  bytes[36] = 1;
  fixture.mints[1].data[0] = btoa(String.fromCharCode(...bytes));
  expect(() =>
    assertSamePairMintEvidence(before, structuredClone(before)),
  ).not.toThrow();
  assertSamePairMintEvidence(before, await read());
  bytes[0] = 1;
  fixture.mints[1].data[0] = btoa(String.fromCharCode(...bytes));
  expect(() =>
    assertSamePairMintEvidence(
      before,
      structuredClone({ ...before, mints: [] }),
    ),
  ).toThrow();
  const after = await read();
  expect(() => assertSamePairMintEvidence(before, after)).toThrow('policy');
  fixture.mints[1] = pairQuoteMint(8, SWAP_TOKEN_2022, [
    {
      __kind: 'ScaledUiAmountConfig',
      authority: address('11111111111111111111111111111111'),
      multiplier: 1,
      newMultiplier: 2,
      newMultiplierEffectiveTimestamp: BigInt(now / 1000 + 1),
    },
  ]);
  const scaled = await read();
  expect(() =>
    assertSamePairMintEvidence(scaled, {
      ...scaled,
      unixTimestamp: String(now / 1000 + 1),
    }),
  ).toThrow('multiplier');
});
