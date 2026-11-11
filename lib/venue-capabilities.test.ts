import { describe, it, expect } from 'vitest';
import {
  VENUE_CAPABILITY_KEYS,
  venueCapabilities,
  venueCapabilityLimits,
  venueFeatureEnabled,
} from './venue-capabilities';
import { venueLimits } from './venue-limits';
import { venueLaunchMethods } from './launch-methods';

const split = (key: string) => key.split('/') as [string, string];
const all = VENUE_CAPABILITY_KEYS.map(split);
const solana = all.filter(([chain]) => chain === 'Solana');

describe('captured venue capability matrix', () => {
  it('covers every chain the captured client nests under `chains`', () => {
    const chains = new Set(VENUE_CAPABILITY_KEYS.map((k) => k.split('/')[0]));
    expect([...chains].sort()).toEqual([
      'Arc',
      'BNB',
      'Base',
      'Ethereum',
      'Robinhood',
      'Solana',
    ]);
    expect(VENUE_CAPABILITY_KEYS).toHaveLength(44);
    expect(solana).toHaveLength(14);
  });

  it('agrees with the venue-limits module on every shared detail field', () => {
    const disagreements: string[] = [];
    for (const [chain, venue] of all) {
      const { profile } = venueCapabilities(chain, venue);
      const limits = venueLimits(chain, venue);
      expect(limits.verified).toBe(true);
      if (!profile) {
        disagreements.push(`${chain}/${venue}: missing profile`);
        continue;
      }
      const observed = {
        maxName: profile.details.maxNameLength,
        maxSymbol: profile.details.maxSymbolLength,
        maxCombined: profile.details.maxCombinedLength,
        descriptionOptional: profile.details.descriptionOptional,
        maxRecipients: profile.limits.maxHolders,
      };
      const expected = {
        maxName: limits.maxName,
        maxSymbol: limits.maxSymbol,
        maxCombined: limits.maxCombined,
        descriptionOptional: limits.descriptionOptional,
        maxRecipients: limits.maxRecipients,
      };
      if (JSON.stringify(observed) !== JSON.stringify(expected))
        disagreements.push(
          `${chain}/${venue}: ${JSON.stringify(observed)} vs ${JSON.stringify(expected)}`,
        );
    }
    expect(disagreements).toEqual([]);
  });

  it('agrees with the launch-methods module on the four launch methods', () => {
    const LABEL = {
      block0: 'Block-0',
      quick: 'Quick',
      stagger: 'Stagger',
      manual: 'Manual',
    } as const;
    const disagreements: string[] = [];
    for (const [chain, venue] of all) {
      const { profile } = venueCapabilities(chain, venue);
      if (!profile) continue;
      const fromFlags = (['block0', 'quick', 'stagger', 'manual'] as const)
        .filter((flag) => profile.launchMethods[flag])
        .map((flag) => LABEL[flag]);
      const expected = venueLaunchMethods(chain, venue);
      if (!expected.captured) {
        disagreements.push(`${chain}/${venue}: no launch-method profile`);
        continue;
      }
      if (JSON.stringify(fromFlags) !== JSON.stringify(expected.methods))
        disagreements.push(
          `${chain}/${venue}: ${fromFlags.join(',')} vs ${expected.methods.join(',')}`,
        );
    }
    expect(disagreements).toEqual([]);
  });

  it('records the initial buy delay exactly where the launch profile enables it', () => {
    // Every venue records a configured default of 11000 ms, but only four
    // enable it. launch-methods.ts collapses the pair to `null` when the flag
    // is off; the two views must agree on which venues that is.
    const enabled: string[] = [];
    for (const [chain, venue] of all) {
      const { profile } = venueCapabilities(chain, venue);
      expect(profile?.launchMethods.initialBuyDelayMs).toBe(11000);
      const fromProfile = venueLaunchMethods(chain, venue).initialBuyDelayMs;
      expect(fromProfile !== null).toBe(profile?.launchMethods.initialBuyDelay);
      if (profile?.launchMethods.initialBuyDelay)
        enabled.push(`${chain}/${venue}`);
    }
    expect(enabled).toEqual([
      'Base/Bankr',
      'Base/Clanker',
      'Robinhood/long.xyz',
      'Robinhood/o1.exchange',
    ]);
  });

  it('carries each venue override as a variant-keyed partial patch', () => {
    const withOverrides = new Map(
      VENUE_CAPABILITY_KEYS.map(
        (key) =>
          [key, venueCapabilities(...split(key)).profile!.overrides] as const,
      ).filter(([, overrides]) => overrides.length),
    );
    expect([...withOverrides.keys()].sort()).toEqual([
      'BNB/FourMeme',
      'Robinhood/flap.sh',
      'Robinhood/long.xyz',
      'Robinhood/o1.exchange',
      'Robinhood/pons.family',
      'Solana/Meteora DAMM V2',
      'Solana/Meteora DLMM',
    ]);
    // The alpha vault disables the sniper guard and allows stagger only.
    const vault = withOverrides
      .get('Solana/Meteora DAMM V2')!
      .find((o) => o.id === 'alpha_vault');
    expect(vault?.sniperGuard?.enabled).toBe(false);
    expect(vault?.launchMethods).toMatchObject({
      block0: false,
      quick: false,
      stagger: true,
      manual: false,
    });
    // A patch declares only the fields it changes. pons_v2 overrides the
    // supply-buy ceiling and nothing else from limits.
    const pons = withOverrides
      .get('Robinhood/pons.family')!
      .find((o) => o.id === 'pons_v2');
    expect(pons?.limits).toEqual({ maxTotalBuyPercentage: 91 });
    expect(pons?.sniperGuard?.enabled).toBe(false);
  });

  it('pins the real per-venue differences rather than assuming uniformity', () => {
    const cap = (key: string) =>
      venueCapabilities(...split(key)).profile?.limits.maxTotalBuyPercentage;
    const at79 = VENUE_CAPABILITY_KEYS.filter((key) => cap(key) === 79);
    expect(at79).toEqual([
      'Arc/flap.sh',
      'BNB/knot.fun',
      'Solana/Bags',
      'Solana/LetsBonk',
      'Solana/StonkFun',
      'Solana/Surge',
      'Solana/Raydium LaunchLab',
    ]);
    // `maxFrontMev` is non-zero on nine venues, and mostly on EVM ones, so it
    // is plainly not the Solana front-wallet cap the launch form applies.
    expect(
      VENUE_CAPABILITY_KEYS.filter(
        (key) =>
          (venueCapabilities(...split(key)).profile?.limits.maxFrontMev ?? 0) >
          0,
      ),
    ).toEqual([
      'Arc/flap.sh',
      'BNB/Flap',
      'Robinhood/flap.sh',
      'Robinhood/hood.fun',
      'Robinhood/long.xyz',
      'Robinhood/meme.bid',
      'Robinhood/o1.exchange',
      'Robinhood/pons.family',
      'Solana/meme.fun',
    ]);
    expect(
      venueCapabilities('Solana', 'meme.fun').profile?.limits.maxFrontMev,
    ).toBe(8);
    // Solana venues otherwise pin it to zero while still allowing the launch
    // form's own 12/8 wallet cap, which is why it cannot be that cap.
    expect(
      venueCapabilities('Solana', 'PumpFun').profile?.limits.maxFrontMev,
    ).toBe(0);

    // Within Solana, streamflow airdrops are PumpFun-only; lock and fee target
    // are absent on StonkFun and Stoxes, and custom mint only on Stoxes.
    const solanaKeys = VENUE_CAPABILITY_KEYS.filter((key) =>
      key.startsWith('Solana/'),
    );
    expect(
      solanaKeys.filter((key) =>
        venueFeatureEnabled(...split(key), 'streamflowAirdrop'),
      ),
    ).toEqual(['Solana/PumpFun']);
    expect(
      solanaKeys.filter((key) => !venueFeatureEnabled(...split(key), 'lock')),
    ).toEqual(['Solana/StonkFun', 'Solana/Stoxes']);
    expect(
      solanaKeys.filter(
        (key) => !venueFeatureEnabled(...split(key), 'feeTarget'),
      ),
    ).toEqual(['Solana/StonkFun', 'Solana/Stoxes']);
    expect(
      solanaKeys.filter(
        (key) => !venueFeatureEnabled(...split(key), 'customMint'),
      ),
    ).toEqual(['Solana/Stoxes']);
    // Off Solana the reference disables lock, fee target, custom mint and
    // streamflow airdrops on every single venue, so none may be assumed on.
    for (const feature of [
      'lock',
      'feeTarget',
      'customMint',
      'streamflowAirdrop',
    ] as const)
      expect(
        VENUE_CAPABILITY_KEYS.filter(
          (key) =>
            !key.startsWith('Solana/') &&
            venueFeatureEnabled(...split(key), feature),
        ),
      ).toEqual([]);
    // Lock and fee target are the two Solana venues the reference withholds
    // them from, so exactly 11 Solana venues carry each.
    expect(
      solanaKeys.filter((key) => venueFeatureEnabled(...split(key), 'lock')),
    ).toHaveLength(12);
  });

  it('treats an uncaptured venue as supporting nothing', () => {
    // The one venue Bundle-tek offers that the capture does not describe.
    expect(venueCapabilities('Robinhood', 'Uniswap V4').captured).toBe(false);
    expect(venueCapabilities('Robinhood', 'Uniswap V4').profile).toBeNull();
    expect(venueCapabilityLimits('Robinhood', 'Uniswap V4')).toBeNull();
    expect(venueCapabilities('Solana', 'NotAVenue').captured).toBe(false);
    for (const feature of [
      'cleanup',
      'sniperGuard',
      'volumeBot',
      'lock',
      'feeTarget',
      'customMint',
    ] as const)
      expect(venueFeatureEnabled('Solana', 'NotAVenue', feature)).toBe(false);
    // An uncaptured chain must not inherit another chain's flags.
    expect(venueFeatureEnabled('Ethereum', 'PumpFun', 'volumeBot')).toBe(false);
  });

  it('exposes the captured wallet limits used by the launch pipeline', () => {
    expect(venueCapabilityLimits('Solana', 'PumpFun')).toMatchObject({
      minHolders: 1,
      maxHolders: 200,
      defaultFrontToBackDelayMs: 500,
      defaultBackToTempDelayMs: 500,
      minBuyDelayMev: 0,
      maxBuyDelayMev: 1000,
      minBuyDelayStagger: 0,
      maxBuyDelayStagger: 60000,
      maxMevStepDelayMs: 10000,
    });
  });
});
