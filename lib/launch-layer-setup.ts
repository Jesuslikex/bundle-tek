import { z } from 'zod';
import { validateProjectDocument } from './workspace-project';
import type { LaunchLayerEnvelope } from './launch-layer-terms';
import { isUploadedArtwork } from './artwork';
import {
  parsePumpCreatorFee,
  validateVenueSettings,
  DEFAULT_VENUE_SETTINGS,
} from './venue-settings';
import { walletAddress } from './wallet-workspace';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const publicUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const u = new URL(value);
      return (
        ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password
      );
    } catch {
      return false;
    }
  });
const identity = z
  .object({
    artworkUrl: z
      .string()
      .max(2048)
      .refine((v) => isUploadedArtwork(v) || publicUrl.safeParse(v).success),
    website: publicUrl,
    twitter: publicUrl,
    telegram: publicUrl,
  })
  .strict();
const pump = z
  .object({
    holderRewards: z.boolean(),
    offchainCreation: z.boolean(),
    feeSharing: z.boolean(),
    creatorFeePercent: z
      .string()
      .refine((v) => {
        try {
          return parsePumpCreatorFee(v) === v;
        } catch {
          return false;
        }
      })
      .nullable(),
    feeShares: z
      .array(
        z
          .object({
            address: z.string().refine((v) => {
              try {
                return walletAddress(v, 'Solana') === v;
              } catch {
                return false;
              }
            }),
            shareBps: z.number().int().min(1).max(10000),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
const schema = z
  .object({
    format: z.literal('launch-layer-setup-v1'),
    projectId: z.string().min(1).max(64),
    projectUpdatedAt: z.iso.datetime(),
    termsSha256: hash,
    snapshotSha256: hash.nullable(),
    identity,
    pumpfun: pump.nullable(),
    planningOnly: z.literal(true),
    fundingAllowed: z.literal(false),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
  })
  .strict();
export type LaunchLayerSetup = z.infer<typeof schema>;
type Binding = Pick<
  LaunchLayerSetup,
  'projectId' | 'projectUpdatedAt' | 'snapshotSha256'
>;

/** Public owner-scoped display only. The caller verifies retained storage first. */
export function createLaunchLayerSetup(
  document: unknown,
  envelope: LaunchLayerEnvelope,
  binding: Binding,
): LaunchLayerSetup {
  const source = validateProjectDocument(document);
  if (
    JSON.stringify(source.plan) !== envelope.terms.binding.savedPlanJson ||
    binding.projectUpdatedAt !== envelope.terms.binding.savedPlanUpdatedAt
  )
    throw new Error('Launch setup source differs from the reviewed plan.');
  const p = source.options.settings.pumpfun;
  return schema.parse({
    format: 'launch-layer-setup-v1',
    ...binding,
    termsSha256: envelope.sha256,
    identity: {
      artworkUrl: source.identity.artworkUrl,
      website: source.identity.website,
      twitter: source.identity.twitter,
      telegram: source.identity.telegram,
    },
    pumpfun:
      envelope.terms.launchpad === 'PumpFun'
        ? {
            holderRewards: p.holderRewards,
            offchainCreation: p.offchainCreation,
            feeSharing: p.feeSharing,
            creatorFeePercent: p.creatorFeePercent ?? null,
            feeShares: p.feeShares.map((leg) => ({ ...leg })),
          }
        : null,
    planningOnly: true,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
}

/** Binds a server display projection to its original saved result, not draft data. */
export function parseLaunchLayerSetup(
  value: unknown,
  envelope: LaunchLayerEnvelope,
  binding: Binding,
): LaunchLayerSetup {
  const v = schema.parse(value);
  if (
    v.projectId !== binding.projectId ||
    v.projectUpdatedAt !== binding.projectUpdatedAt ||
    v.projectUpdatedAt !== envelope.terms.binding.savedPlanUpdatedAt ||
    v.termsSha256 !== envelope.sha256 ||
    v.snapshotSha256 !== binding.snapshotSha256 ||
    (v.pumpfun !== null) !== (envelope.terms.launchpad === 'PumpFun')
  )
    throw new Error('Launch setup binding differs.');
  if (v.pumpfun) {
    const { creatorFeePercent, ...rest } = v.pumpfun;
    validateVenueSettings(
      {
        pumpfun: {
          ...rest,
          ...(creatorFeePercent === null ? {} : { creatorFeePercent }),
        },
        flap: DEFAULT_VENUE_SETTINGS.flap,
      },
      'Solana',
      envelope.terms.launchpad,
      envelope.terms.quote.address,
    );
  }
  return v;
}
