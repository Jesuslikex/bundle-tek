import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { decodeCurveBuy } from './sniper-guard-chain';
import {
  VENUE_SNIPER_STORED_BUYS,
  applyVenueSniperRead,
  armVenueSniper,
  parseVenueSniperState,
  stopVenueSniper,
  venueSniperSettings,
  type VenueSniperRead,
} from './venue-sniper-guard';
import type { SniperGuardCurveBuy } from './sniper-guard';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const sig = (n: number) =>
  bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i ? n : 1)));
const pool = key(40),
  vault = key(43),
  authority = key(44),
  wsol = 'So11111111111111111111111111111111111111112',
  buyer = key(9),
  dev = key(7);
const launch = {
  venue: 'launchlab' as const,
  id: crypto.randomUUID(),
  mint: key(50),
  developer: dev,
};
const buy = (n: number, raw: string, signer = buyer): SniperGuardCurveBuy => ({
  signature: sig(n),
  slot: 100 + n,
  blockTime: null,
  signers: [signer],
  quoteInRaw: raw,
});
const read = (
  buys: SniperGuardCurveBuy[],
  extra: Partial<VenueSniperRead> = {},
) => ({
  buys,
  excludedCount: 0,
  cursor: buys.at(-1)?.signature ?? null,
  complete: true,
  pending: false,
  ...extra,
});
const settings = (seconds = 60) =>
  venueSniperSettings({ thresholdRaw: '1000', seconds, whitelist: [] });

function vaultTx(before: string | null, after: string, vaultOwner = authority) {
  const row = (amount: string) => ({
    accountIndex: 2,
    mint: wsol,
    owner: vaultOwner,
    uiTokenAmount: { amount },
  });
  return {
    slot: 700,
    blockTime: 1_800_000_000,
    meta: {
      err: null,
      preBalances: [1, 1, 1],
      postBalances: [1, 1, 1],
      preTokenBalances: before === null ? [] : [row(before)],
      postTokenBalances: [row(after)],
    },
    transaction: {
      signatures: [sig(3)],
      message: {
        accountKeys: [
          { pubkey: buyer, signer: true },
          { pubkey: pool, signer: false },
          { pubkey: vault, signer: false },
        ],
      },
    },
  };
}

describe('pool quote vault decoding', () => {
  const scope = { bondingCurve: pool, quoteMint: wsol, quoteVault: vault };
  it('measures wrapped SOL paid into a vault owned by a shared authority', () => {
    expect(decodeCurveBuy(vaultTx('5000', '7500'), scope)).toMatchObject({
      signers: [buyer],
      quoteInRaw: '2500',
    });
  });
  it('ignores sells and transactions that do not touch the vault', () => {
    expect(decodeCurveBuy(vaultTx('7500', '5000'), scope)).toBeNull();
    expect(
      decodeCurveBuy(vaultTx('5000', '7500'), {
        ...scope,
        quoteVault: key(45),
      }),
    ).toBeNull();
  });
  it('does not treat a wrapped-SOL vault as lamports on the pool', () => {
    // Without quoteVault the native path would read pool lamports (unchanged).
    expect(
      decodeCurveBuy(vaultTx('5000', '7500'), {
        bondingCurve: pool,
        quoteMint: wsol,
      }),
    ).toBeNull();
  });
});

describe('venue Sniper Guard', () => {
  it('only supports a timed developer-only Nuke', () => {
    const s = settings();
    expect(s.response).toEqual({
      kind: 'nuke',
      scope: 'dev',
      completeEarly: false,
    });
    expect(() =>
      armVenueSniper(
        launch,
        { ...s, end: { kind: 'until-complete' } },
        'nuke',
        0,
      ),
    ).toThrow(/timed/);
  });
  it('triggers only when outside buys strictly exceed the threshold', () => {
    let state = armVenueSniper(launch, settings(), 'nuke', 0);
    state = applyVenueSniperRead(
      state,
      read([buy(1, '600'), buy(2, '400')]),
      1000,
    );
    expect(state.status).toBe('watching');
    expect(state.externalTotalRaw).toBe('1000');
    state = applyVenueSniperRead(state, read([buy(3, '1')]), 2000);
    expect(state.status).toBe('triggered');
    expect(state.triggeringSignature).toBe(sig(3));
    expect(state.finishedAt).toBe(2000);
    // A triggered guard ignores later reads.
    expect(applyVenueSniperRead(state, read([buy(4, '9')]), 3000)).toBe(state);
  });
  it('dedupes repeated buys and never counts the developer or whitelist', () => {
    const white = key(11);
    let state = armVenueSniper(
      launch,
      venueSniperSettings({
        thresholdRaw: '1000',
        seconds: 60,
        whitelist: [white],
      }),
      'alert',
      0,
    );
    state = applyVenueSniperRead(
      state,
      read([
        buy(1, '900'),
        buy(1, '900'),
        buy(2, '900', dev),
        buy(3, '900', white),
      ]),
      1,
    );
    expect(state.externalTotalRaw).toBe('900');
    expect(state.status).toBe('watching');
  });
  it('ends after the watch window and when capacity is exceeded', () => {
    let state = armVenueSniper(launch, settings(10), 'nuke', 0);
    state = applyVenueSniperRead(state, read([]), 10_000);
    expect(state.status).toBe('ended');
    let full = armVenueSniper(
      launch,
      venueSniperSettings({
        thresholdRaw: '99999999999',
        seconds: 60,
        whitelist: [],
      }),
      'nuke',
      0,
    );
    full = applyVenueSniperRead(
      full,
      read(
        Array.from({ length: VENUE_SNIPER_STORED_BUYS + 1 }, (_, i) => ({
          ...buy(1, '1'),
          signature: bs58.encode(
            Uint8Array.from({ length: 64 }, (_, j) =>
              j === 0 ? 1 : j === 1 ? i & 255 : j === 2 ? i >> 8 : 7,
            ),
          ),
        })),
      ),
      1,
    );
    expect(full.status).toBe('ended');
    expect(full.coverage).toBe('partial');
    expect(full.buys).toHaveLength(VENUE_SNIPER_STORED_BUYS);
  });
  it('marks partial coverage when a poll overflows its page budget', () => {
    let state = armVenueSniper(launch, settings(), 'nuke', 0);
    state = applyVenueSniperRead(state, read([], { complete: false }), 1);
    expect(state.coverage).toBe('partial');
  });
  it('stops, saves and reloads only for the same launch', () => {
    let state = armVenueSniper(launch, settings(), 'nuke', 5);
    state = applyVenueSniperRead(state, read([buy(1, '700')]), 6);
    const text = JSON.stringify(state);
    expect(parseVenueSniperState(text, launch)).toEqual(state);
    expect(() =>
      parseVenueSniperState(text, { ...launch, mint: key(51) }),
    ).toThrow(/differs/);
    expect(parseVenueSniperState(null, launch)).toBeNull();
    const stopped = stopVenueSniper(state, 9);
    expect(stopped).toMatchObject({ status: 'stopped', finishedAt: 9 });
    expect(stopVenueSniper(stopped, 10)).toBe(stopped);
  });
});
