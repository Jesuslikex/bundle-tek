import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  evaluateSniperGuard,
  parseSniperGuardSettings,
  sniperGuardActions,
  sniperGuardDisplay,
  sniperGuardThresholdRaw,
  type SniperGuardCurveBuy,
  type SniperGuardSettings,
} from './sniper-guard';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const sig = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
const dev = key(1),
  holderA = key(2),
  holderB = key(3),
  sniper = key(9),
  friend = key(10),
  otherOwned = key(11);
const launch = { developer: dev, holders: [holderA, holderB] };
const settings = (
  patch: Partial<SniperGuardSettings> = {},
): SniperGuardSettings => ({
  format: 'sniper-guard-settings-v1',
  thresholdRaw: '5000000000',
  response: { kind: 'nuke', scope: 'all' },
  end: { kind: 'timed', seconds: 60 },
  whitelist: [],
  ...patch,
});
const buy = (
  n: number,
  signer: string,
  quoteInRaw: string,
  slot = 100 + n,
): SniperGuardCurveBuy => ({
  signature: sig(n),
  slot,
  blockTime: null,
  signers: [signer],
  quoteInRaw,
});
const evaluate = (
  buys: SniperGuardCurveBuy[],
  patch: Partial<SniperGuardSettings> = {},
  extra: Partial<Parameters<typeof evaluateSniperGuard>[0]> = {},
) =>
  evaluateSniperGuard({
    settings: settings(patch),
    launch,
    ownedWallets: [otherOwned],
    buys,
    armedAtMs: 0,
    nowMs: 1000,
    launchBuysComplete: false,
    ...extra,
  });

describe('Sniper Guard settings', () => {
  it('accepts each documented response and end condition', () => {
    for (const response of [
      { kind: 'nuke', scope: 'all' },
      { kind: 'nuke', scope: 'holders' },
      { kind: 'nuke', scope: 'dev', completeEarly: true },
      { kind: 'nuke', scope: 'dev', completeEarly: false },
      { kind: 'complete-early' },
    ])
      expect(
        parseSniperGuardSettings({ ...settings(), response }).response,
      ).toEqual(response);
    expect(
      parseSniperGuardSettings({
        ...settings(),
        end: { kind: 'until-complete' },
      }).end,
    ).toEqual({ kind: 'until-complete' });
  });
  it('rejects zero thresholds, sub-second timers and malformed responses', () => {
    expect(() =>
      parseSniperGuardSettings({ ...settings(), thresholdRaw: '0' }),
    ).toThrow('greater than zero');
    expect(() =>
      parseSniperGuardSettings({
        ...settings(),
        end: { kind: 'timed', seconds: 0 },
      }),
    ).toThrow();
    expect(() =>
      parseSniperGuardSettings({
        ...settings(),
        response: { kind: 'nuke', scope: 'all', completeEarly: true },
      }),
    ).toThrow('response');
    expect(() =>
      parseSniperGuardSettings({
        ...settings(),
        response: { kind: 'nuke', scope: 'dev' },
      }),
    ).toThrow('response');
    expect(() =>
      parseSniperGuardSettings({ ...settings(), extra: true }),
    ).toThrow('differ');
  });
  it('validates and de-duplicates the whitelist', () => {
    expect(
      parseSniperGuardSettings({ ...settings(), whitelist: [friend] })
        .whitelist,
    ).toEqual([friend]);
    expect(() =>
      parseSniperGuardSettings({ ...settings(), whitelist: [friend, friend] }),
    ).toThrow('duplicate');
    expect(() =>
      parseSniperGuardSettings({ ...settings(), whitelist: ['nope'] }),
    ).toThrow();
  });
  it('converts typed amounts to exact raw units and back', () => {
    expect(sniperGuardThresholdRaw('5', 9)).toBe('5000000000');
    expect(sniperGuardThresholdRaw('0.25', 6)).toBe('250000');
    expect(() => sniperGuardThresholdRaw('0.0000001', 6)).toThrow('decimal');
    expect(() => sniperGuardThresholdRaw('0', 9)).toThrow('greater than zero');
    expect(() => sniperGuardThresholdRaw('-1', 9)).toThrow();
    expect(sniperGuardDisplay('5000000000', 9)).toBe('5');
    expect(sniperGuardDisplay('250000', 6)).toBe('0.25');
    expect(sniperGuardDisplay('1', 9)).toBe('0.000000001');
  });
});

describe('Sniper Guard evaluation', () => {
  it('triggers only when external buys are strictly above the threshold', () => {
    const exactly = evaluate([
      buy(1, sniper, '3000000000'),
      buy(2, key(12), '2000000000'),
    ]);
    expect(exactly.externalTotalRaw).toBe('5000000000');
    expect(exactly.triggered).toBe(false);
    const over = evaluate([
      buy(1, sniper, '3000000000'),
      buy(2, key(12), '2000000000'),
      buy(3, key(13), '1'),
    ]);
    expect(over.triggered).toBe(true);
    expect(over.triggeringSignature).toBe(sig(3));
    expect(over.actions?.sellWallets).toEqual([dev, holderA, holderB]);
  });
  it('ignores launch wallets, other owned wallets and the whitelist', () => {
    const result = evaluate(
      [
        buy(1, dev, '9000000000'),
        buy(2, holderA, '9000000000'),
        buy(3, otherOwned, '9000000000'),
        buy(4, friend, '9000000000'),
        buy(5, sniper, '1000000000'),
      ],
      { whitelist: [friend] },
    );
    expect(result.excludedCount).toBe(4);
    expect(result.externalTotalRaw).toBe('1000000000');
    expect(result.triggered).toBe(false);
  });
  it('excludes a buy when any signer is a launch wallet', () => {
    const shared = { ...buy(1, sniper, '9000000000'), signers: [sniper, dev] };
    expect(evaluate([shared]).externalTotalRaw).toBe('0');
  });
  it('counts each signature once and in slot order', () => {
    const late = buy(1, sniper, '4000000000', 300),
      early = buy(2, key(12), '2000000000', 200);
    const result = evaluate([late, early, late]);
    expect(result.counted.map((b) => b.signature)).toEqual([sig(2), sig(1)]);
    expect(result.triggeringSignature).toBe(sig(1));
  });
  it('ends on the timer or when launch buys finish, unless already triggered', () => {
    expect(
      evaluate([], { end: { kind: 'timed', seconds: 1 } }, { nowMs: 999 })
        .ended,
    ).toBe(false);
    expect(
      evaluate([], { end: { kind: 'timed', seconds: 1 } }, { nowMs: 1000 })
        .endReason,
    ).toBe('timed');
    expect(
      evaluate([], { end: { kind: 'until-complete' } }, { nowMs: 9e12 }).ended,
    ).toBe(false);
    expect(
      evaluate(
        [],
        { end: { kind: 'until-complete' } },
        { launchBuysComplete: true },
      ).endReason,
    ).toBe('launch-complete');
    const triggered = evaluate(
      [buy(1, sniper, '6000000000')],
      { end: { kind: 'timed', seconds: 1 } },
      { nowMs: 5000 },
    );
    expect(triggered.triggered).toBe(true);
    expect(triggered.ended).toBe(false);
  });
});

describe('Sniper Guard responses', () => {
  it('maps Nuke scopes and Complete Early like Proxima', () => {
    expect(
      sniperGuardActions(
        settings({ response: { kind: 'nuke', scope: 'all' } }),
        launch,
      ),
    ).toEqual({
      sellWallets: [dev, holderA, holderB],
      keepWallets: [],
      stopRemainingBuys: true,
    });
    expect(
      sniperGuardActions(
        settings({ response: { kind: 'nuke', scope: 'holders' } }),
        launch,
      ),
    ).toEqual({
      sellWallets: [holderA, holderB],
      keepWallets: [dev],
      stopRemainingBuys: true,
    });
    expect(
      sniperGuardActions(
        settings({
          response: { kind: 'nuke', scope: 'dev', completeEarly: false },
        }),
        launch,
      ),
    ).toEqual({
      sellWallets: [dev],
      keepWallets: [holderA, holderB],
      stopRemainingBuys: false,
    });
    expect(
      sniperGuardActions(
        settings({
          response: { kind: 'nuke', scope: 'dev', completeEarly: true },
        }),
        launch,
      ).stopRemainingBuys,
    ).toBe(true);
    expect(
      sniperGuardActions(
        settings({ response: { kind: 'complete-early' } }),
        launch,
      ),
    ).toEqual({
      sellWallets: [],
      keepWallets: [dev, holderA, holderB],
      stopRemainingBuys: true,
    });
  });
  it('never lists the developer twice when it also holds a holder slot', () => {
    expect(
      sniperGuardActions(settings(), {
        developer: dev,
        holders: [dev, holderA],
      }).sellWallets,
    ).toEqual([dev, holderA]);
  });
});
