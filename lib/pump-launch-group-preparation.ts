import {
  prepareOwnedPumpHolderContext,
  assertOwnedHolderContext,
} from './pump-holder-preparation';
import { collectPumpLaunchGroupFunding } from './pump-holder-funding';
import { buildPumpLaunchPacketGroup } from './pump-launch-packet-group';
import { collectPumpLaunchGroupSimulation } from './pump-launch-group-simulation';
import { PumpPreflightError } from './owned-pump-preflight';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { encodePumpSigningInput } from './pump-launch-signing';
import { canonicalPumpHolderJson } from './pump-holder-review';

type Terms = Parameters<typeof prepareOwnedPumpHolderContext>[2];
type Input = Awaited<ReturnType<typeof prepareOwnedPumpHolderContext>>['input'];
/** Server-internal owned complete-group preparation. No persistence, reservations, approval, signing or submission. */
export async function preflightOwnedPumpLaunchGroup(
  db: D1Database,
  owner: string,
  supplied: Terms,
  signal: AbortSignal,
  options: {
    rpc: PumpLaunchRpc;
    lifetime?: { blockhash: string; lastValidBlockHeight: string };
    captureInput?: (input: Input) => void;
    originalInput?: Input;
  },
) {
  const terms = structuredClone(supplied),
    deadline = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  deadline.throwIfAborted();
  const context = await prepareOwnedPumpHolderContext(
    db,
    owner,
    terms,
    deadline,
    { rpc: options.rpc, lifetime: options.lifetime },
  );
  let input = structuredClone(context.input);
  if (options.originalInput) {
    const original = structuredClone(options.originalInput);
    const stable = (value: Input) => {
      const create = encodePumpSigningInput(value.create);
      return {
        ...value,
        create: {
          ...create,
          global: { ...create.global, slot: 0 },
          ...(create.quoteMintAccount
            ? { quoteMintAccount: { ...create.quoteMintAccount, slot: 0 } }
            : {}),
          ...(create.quoteControl
            ? { quoteControl: { ...create.quoteControl, slot: 0 } }
            : {}),
        },
      };
    };
    if (
      canonicalPumpHolderJson(stable(input)) !==
      canonicalPumpHolderJson(stable(original))
    )
      throw new PumpPreflightError(
        'Fresh group configuration, targets or limits differ from the original review.',
        409,
      );
    input = original;
  }
  const group = await buildPumpLaunchPacketGroup(input, deadline);
  if (group.packets.length > 5)
    throw new PumpPreflightError(
      'This launch exceeds one five-packet group. No subset or alternative execution policy is enabled.',
      409,
    );
  const binding = { ...context, packet: group };
  await assertOwnedHolderContext(db, owner, terms, input, binding, deadline);
  const funding = await collectPumpLaunchGroupFunding(
    input,
    context.allowances,
    context.creationSimulation,
    deadline,
    options.rpc,
  );
  if (
    funding.manifestSha256 !== group.manifestSha256 ||
    funding.allowanceSha256 !== context.allowanceSha256
  )
    throw new PumpPreflightError('Owned group funding binding changed.', 409);
  await assertOwnedHolderContext(db, owner, terms, input, binding, deadline);
  const simulation = await collectPumpLaunchGroupSimulation(
    input,
    context.allowances,
    funding,
    context.creationSimulation,
    deadline,
    options.rpc,
  );
  if (
    simulation.manifestSha256 !== group.manifestSha256 ||
    simulation.allowanceSha256 !== context.allowanceSha256
  )
    throw new PumpPreflightError(
      'Owned group simulation binding changed.',
      409,
    );
  await assertOwnedHolderContext(db, owner, terms, input, binding, deadline);
  deadline.throwIfAborted();
  options.captureInput?.(structuredClone(input));
  return {
    format: 'pump-owned-launch-group-preflight-v1' as const,
    projectId: terms.projectId,
    projectUpdatedAt: terms.updatedAt,
    metadataReleaseId: terms.releaseId,
    metadataUri: context.metadataUri,
    group,
    targets: context.targets,
    allowances: context.allowances,
    deployerBindingSha256: context.deployerBindingSha256,
    holderBindingSha256: context.holderBindingSha256,
    allowanceSha256: context.allowanceSha256,
    creationSimulation: context.creationSimulation,
    funding,
    simulation,
    fundingValidated: true as const,
    settlementValidated: true as const,
    durableReviewRequired: true as const,
    reservationRequired: true as const,
    programDeploymentReviewRequired: true as const,
    transportReviewRequired: true as const,
    authorityReviewRequired: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    completeLaunch: false as const,
  };
}
