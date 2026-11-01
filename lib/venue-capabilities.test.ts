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
// Every captured venue is a Solana venue in this release.
const solana = VENUE_CAPABILITY_KEYS.map(split);

describe('captured venue capability matrix', () => {
  it('was extracted for the same release the other captured modules cite', () => {
    expect(VENUE_CAPABILITY_KEYS).toHaveLength(13);
    expect(VENUE_CAPABILITY_KEYS.every((k) => k.startsWith('Solana/'))).toBe(
      true,
    );
  });

  it('agrees with the venue-limits module on every shared detail field', () => {
    const disagreements: string[] = [];
    for (const [chain, venue] of solana) {
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
    const disagreements: string[] = [];
    for (const [chain, venue] of solana) {
      const { profile } = venueCapabilities(chain, venue);
      if (!profile) continue;
      const methods = profile.launchMethods;
      const fromFlags = (
        ['block0', 'quick', 'stagger', 'manual'] as const
      ).filter((flag) => methods[flag]);
      // The captured table calls the sequenced method "block0"; the launch
      // profile calls it "Block-0".
      const normalized = fromFlags.map((flag) =>
        flag === 'block0'
          ? 'Block-0'
          : flag === 'quick'
            ? 'Quick'
            : flag === 'stagger'
              ? 'Stagger'
              : 'Manual',
      );
      const expected = venueLaunchMethods(chain, venue).methods;
      if (JSON.stringify(normalized) !== JSON.stringify(expected))
        disagreements.push(
          `${chain}/${venue}: ${normalized.join(',')} vs ${expected.join(',')}`,
        );
    }
    expect(disagreements).toEqual([]);
  });

  it('keeps the dormant initial-buy-delay value the launch profile drops', () => {
    // The captured table disables the initial buy delay on every Solana venue
    // while still recording its configured default. launch-methods.ts collapses
    // that pair to null; this module keeps both so the default stays visible.
    for (const [chain, venue] of solana) {
      const { profile } = venueCapabilities(chain, venue);
      expect(profile?.launchMethods.initialBuyDelay).toBe(false);
      expect(profile?.launchMethods.initialBuyDelayMs).toBe(11000);
    }
  });

  it('carries the alpha-vault override on exactly the two Meteora profiles', () => {
    const withVault = VENUE_CAPABILITY_KEYS.filter(
      (key) => venueCapabilities(...split(key)).profile?.alphaVault,
    );
    expect(withVault).toEqual([
      'Solana/Meteora DAMM V2',
      'Solana/Meteora DLMM',
    ]);
    for (const key of withVault) {
      const override = venueCapabilities(...split(key)).profile?.alphaVault;
      expect(override?.id).toBe('alpha_vault');
      // The vault disables the sniper guard and allows stagger only.
      expect(override?.sniperGuard.enabled).toBe(false);
      expect(override?.launchMethods).toMatchObject({
        block0: false,
        quick: false,
        stagger: true,
        manual: false,
      });
    }
  });

  it('pins the real per-venue differences rather than assuming uniformity', () => {
    const buyCap = (key: string) =>
      venueCapabilities(...split(key)).profile?.limits.maxTotalBuyPercentage;
    expect(VENUE_CAPABILITY_KEYS.filter((key) => buyCap(key) === 79)).toEqual([
      'Solana/Bags',
      'Solana/LetsBonk',
      'Solana/StonkFun',
      'Solana/Surge',
    ]);
    expect(
      VENUE_CAPABILITY_KEYS.filter(
        (key) =>
          venueCapabilities(...split(key)).profile?.limits.maxFrontMev === 8,
      ),
    ).toEqual(['Solana/meme.fun']);

    // Streamflow airdrops are PumpFun-only in this release.
    expect(
      VENUE_CAPABILITY_KEYS.filter((key) =>
        venueFeatureEnabled(...split(key), 'streamflowAirdrop'),
      ),
    ).toEqual(['Solana/PumpFun']);
    // Lock and fee target are absent on StonkFun and Stoxes; custom mint only
    // on Stoxes.
    expect(
      VENUE_CAPABILITY_KEYS.filter(
        (key) => !venueFeatureEnabled(...split(key), 'lock'),
      ),
    ).toEqual(['Solana/StonkFun', 'Solana/Stoxes']);
    expect(
      VENUE_CAPABILITY_KEYS.filter(
        (key) => !venueFeatureEnabled(...split(key), 'feeTarget'),
      ),
    ).toEqual(['Solana/StonkFun', 'Solana/Stoxes']);
    expect(
      VENUE_CAPABILITY_KEYS.filter(
        (key) => !venueFeatureEnabled(...split(key), 'customMint'),
      ),
    ).toEqual(['Solana/Stoxes']);
  });

  it('treats an uncaptured venue as supporting nothing', () => {
    expect(venueCapabilities('Solana', 'NotAVenue').captured).toBe(false);
    expect(venueCapabilities('Solana', 'NotAVenue').profile).toBeNull();
    expect(venueCapabilityLimits('Solana', 'NotAVenue')).toBeNull();
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
