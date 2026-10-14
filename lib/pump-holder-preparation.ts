import {
  preflightOwnedPumpCreate,
  readOwnedPumpCreateBinding,
  PumpPreflightError,
  type OwnedPumpTerms,
} from './owned-pump-preflight';
import {
  readOwnedPumpHolderWallets,
  readOwnedPumpHolderSelection,
} from './pump-holder-selection';
import {
  buildPumpCreateHolderMessage,
  type PumpHolderBuy,
} from './pump-holder-message';
import { decodePumpLaunchConfig } from './pump-launch-config';
import { pumpDeveloperBuyTarget } from './pump-initial-buy-preparation';
import type { PumpCreateInput } from './pump-launch-message';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { collectPumpHolderFunding } from './pump-holder-funding';
import { simulatePumpHolderPacket } from './pump-holder-simulation';
type Limits = {
  address: string;
  feeAndRentLimitRaw: string;
  maximumQuoteCostRaw?: string;
  minimumTokenOutputRaw?: string;
};
type Terms = OwnedPumpTerms & {
  developerMaximumQuoteCostRaw?: string;
  holderLimits: Limits[];
};
const fail = (message: string): never => {
  throw new PumpPreflightError(message, 409);
};
const uint = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    fail('Review positive exact per-wallet limits.');
  return BigInt(value);
};

/** Owned unsigned packet preparation. A create-only simulation cannot authorize this larger transaction. */
export async function prepareOwnedPumpHolderPacket(
  db: D1Database,
  owner: string,
  supplied: Terms,
  signal: AbortSignal,
  options: {
    rpc?: PumpLaunchRpc;
    lifetime?: { blockhash: string; lastValidBlockHeight: string };
    captureInput?: (
      input: Parameters<typeof buildPumpCreateHolderMessage>[0],
    ) => void;
  } = {},
) {
  const terms = structuredClone(supplied);
  if (
    Object.keys(terms).some(
      (k) =>
        ![
          'projectId',
          'updatedAt',
          'releaseId',
          'origin',
          'payer',
          'payerRevision',
          'mint',
          'feeAndRentLimitRaw',
          'developerMaximumQuoteCostRaw',
          'holderLimits',
        ].includes(k),
    ) ||
    !Array.isArray(terms.holderLimits) ||
    !terms.holderLimits.length ||
    terms.holderLimits.length > 200
  )
    fail(
      'Use the saved holder plan with explicit per-wallet limits; targets cannot be overridden.',
    );
  if (uint(terms.feeAndRentLimitRaw) > 1000000000n)
    fail('Review at most 1 SOL of deployer fee/rent allowance.');
  const { holderLimits, developerMaximumQuoteCostRaw, ...createTerms } = terms;
  const deployerBinding = await readOwnedPumpCreateBinding(
    db,
    owner,
    createTerms,
    signal,
  );
  const wallets = await readOwnedPumpHolderWallets(db, owner, terms);
  if (
    holderLimits.length !==
      wallets.document.options.wallets!.recipients.length ||
    holderLimits.some(
      (limit, index) =>
        limit.address !==
        wallets.document.options.wallets!.recipients[index].address,
    )
  )
    fail('Per-wallet limits must match every saved holder slot in order.');
  if (wallets.document.plan.developerBuy > 0) {
    if (developerMaximumQuoteCostRaw === undefined)
      fail('Review the developer quote-spend cap.');
    uint(developerMaximumQuoteCostRaw!);
  } else if (developerMaximumQuoteCostRaw !== undefined)
    fail('No developer buy is saved for this launch.');
  // Cheap limit validation precedes any provider reads. Per-kind exactness is checked after observed sizing.
  for (const limit of holderLimits) {
    if (
      Object.keys(limit).some(
        (k) =>
          ![
            'address',
            'feeAndRentLimitRaw',
            'maximumQuoteCostRaw',
            'minimumTokenOutputRaw',
          ].includes(k),
      )
    )
      fail('Unexpected holder limit fields.');
    if (
      limit.feeAndRentLimitRaw !== '0' &&
      uint(limit.feeAndRentLimitRaw) > 1000000000n
    )
      fail('Review at most 1 SOL of holder fee/rent allowance.');
    if (limit.maximumQuoteCostRaw !== undefined)
      uint(limit.maximumQuoteCostRaw);
    if (limit.minimumTokenOutputRaw !== undefined)
      uint(limit.minimumTokenOutputRaw);
  }
  let create: PumpCreateInput | undefined;
  const creation = await preflightOwnedPumpCreate(
    db,
    owner,
    createTerms,
    signal,
    {
      rpc: options.rpc,
      lifetime: options.lifetime,
      captureInput: (input) => {
        create = input;
      },
    },
  );
  if (!create || signal.aborted)
    return fail('Holder packet preparation interrupted.');
  const global = decodePumpLaunchConfig('Global', create.global.data);
  if (typeof global.initial_real_token_reserves !== 'bigint')
    return fail('Observed initial curve reserve unavailable.');
  const selection = await readOwnedPumpHolderSelection(db, owner, {
    projectId: terms.projectId,
    updatedAt: terms.updatedAt,
    observation: {
      tokenSupplyRaw: creation.quote.tokenSupplyRaw,
      initialRealTokenReservesRaw:
        global.initial_real_token_reserves.toString(),
      quoteMint: creation.quote.mint,
      quoteDecimals: creation.quote.decimals,
    },
  });
  const holders: PumpHolderBuy[] = selection.targets.items.map(
    (item, index) => {
      const limit = holderLimits[index];
      if (!item.participates) {
        if (
          limit.feeAndRentLimitRaw !== '0' ||
          limit.maximumQuoteCostRaw !== undefined ||
          limit.minimumTokenOutputRaw !== undefined
        )
          fail(
            'Inactive holder slots must have zero allowance and no buy limits.',
          );
        return { address: item.wallet.address, kind: 'none' };
      }
      if (limit.feeAndRentLimitRaw === '0')
        fail('Active holder slots need an explicit fee/rent allowance.');
      if (selection.targets.kind === 'exact-base-output') {
        if (
          limit.maximumQuoteCostRaw === undefined ||
          limit.minimumTokenOutputRaw !== undefined
        )
          fail('Every supply-target holder needs its own quote cap.');
        return {
          address: item.wallet.address,
          kind: 'exact-base-output',
          tokenAmountRaw: item.tokenAmountRaw!,
          maximumQuoteCostRaw: limit.maximumQuoteCostRaw!,
        };
      }
      if (
        limit.minimumTokenOutputRaw === undefined ||
        limit.maximumQuoteCostRaw !== undefined
      )
        fail(
          'Every quote-budget holder needs an explicit minimum token output.',
        );
      return {
        address: item.wallet.address,
        kind: 'exact-quote-input',
        quoteAmountRaw: item.quoteAmountRaw!,
        minimumTokenOutputRaw: limit.minimumTokenOutputRaw!,
      };
    },
  );
  const developer =
    wallets.document.plan.developerBuy > 0
      ? {
          tokenAmountRaw: pumpDeveloperBuyTarget(
            creation.quote.tokenSupplyRaw,
            wallets.document.plan.developerBuy,
          ),
          maximumQuoteCostRaw: developerMaximumQuoteCostRaw!,
        }
      : undefined;
  const packet = await buildPumpCreateHolderMessage(
    { create, holders, ...(developer ? { developer } : {}) },
    signal,
  );
  const after = await readOwnedPumpHolderWallets(db, owner, terms);
  if (
    after.bindingSha256 !== wallets.bindingSha256 ||
    (await readOwnedPumpCreateBinding(db, owner, createTerms, signal)) !==
      deployerBinding ||
    signal.aborted
  )
    return fail(
      'Saved project, deployer or holder selection changed during packet preparation.',
    );
  const canonicalLimits = {
    deployerFeeAndRentLimitRaw: terms.feeAndRentLimitRaw,
    developerMaximumQuoteCostRaw: developerMaximumQuoteCostRaw ?? null,
    holders: holderLimits.map((l) => ({
      address: l.address,
      feeAndRentLimitRaw: l.feeAndRentLimitRaw,
      maximumQuoteCostRaw: l.maximumQuoteCostRaw ?? null,
      minimumTokenOutputRaw: l.minimumTokenOutputRaw ?? null,
    })),
  };
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(canonicalLimits)),
    ),
  );
  options.captureInput?.(
    structuredClone({ create, holders, ...(developer ? { developer } : {}) }),
  );
  return {
    format: 'pump-owned-holder-packet-v1' as const,
    projectId: terms.projectId,
    projectUpdatedAt: terms.updatedAt,
    metadataReleaseId: terms.releaseId,
    metadataUri: creation.metadataUri,
    packet,
    targets: selection.targets,
    allowances: canonicalLimits,
    deployerBindingSha256: deployerBinding,
    holderBindingSha256: selection.bindingSha256,
    allowanceSha256: Array.from(bytes, (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    creationSimulation: creation.simulation,
    allWalletSimulation: null,
    fundingValidated: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    completeLaunch: false as const,
  };
}

/** Owned, read-only all-wallet funding check. Settlement and signing remain separate pending gates. */
export async function preflightOwnedPumpHolderFunding(
  db: D1Database,
  owner: string,
  supplied: Terms,
  signal: AbortSignal,
  options: {
    rpc?: PumpLaunchRpc;
    lifetime?: { blockhash: string; lastValidBlockHeight: string };
    captureInput?: (
      input: Parameters<typeof buildPumpCreateHolderMessage>[0],
    ) => void;
  } = {},
) {
  const terms = structuredClone(supplied);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  let input: Parameters<typeof buildPumpCreateHolderMessage>[0] | undefined;
  const prepared = await prepareOwnedPumpHolderPacket(
    db,
    owner,
    terms,
    deadline,
    {
      rpc: options.rpc,
      lifetime: options.lifetime,
      captureInput: (captured) => {
        input = captured;
      },
    },
  );
  if (!input) return fail('Owned holder funding context is unavailable.');
  const funding = await collectPumpHolderFunding(
    input,
    prepared.allowances,
    prepared.creationSimulation,
    deadline,
    options.rpc,
  );
  if (
    funding.packetSha256 !== prepared.packet.packetSha256 ||
    funding.allowanceSha256 !== prepared.allowanceSha256
  )
    return fail('Holder funding context changed; prepare a new review.');
  await assertOwnedHolderContext(db, owner, terms, input, prepared, deadline);
  options.captureInput?.(structuredClone(input));
  return { ...prepared, funding, fundingValidated: true as const };
}

async function assertOwnedHolderContext(
  db: D1Database,
  owner: string,
  terms: Terms,
  input: Parameters<typeof buildPumpCreateHolderMessage>[0],
  prepared: Pick<
    Awaited<ReturnType<typeof prepareOwnedPumpHolderPacket>>,
    'packet' | 'holderBindingSha256' | 'deployerBindingSha256'
  >,
  signal: AbortSignal,
) {
  const global = decodePumpLaunchConfig('Global', input.create.global.data);
  if (typeof global.initial_real_token_reserves !== 'bigint')
    return fail('Observed initial curve reserve unavailable.');
  const after = await readOwnedPumpHolderSelection(db, owner, {
    projectId: terms.projectId,
    updatedAt: terms.updatedAt,
    observation: {
      tokenSupplyRaw: prepared.packet.quote.tokenSupplyRaw,
      initialRealTokenReservesRaw:
        global.initial_real_token_reserves.toString(),
      quoteMint: input.create.quoteMint,
      quoteDecimals: prepared.packet.quote.decimals,
    },
  });
  const {
    holderLimits: _holderLimits,
    developerMaximumQuoteCostRaw: _developerLimit,
    ...createTerms
  } = terms;
  if (
    after.bindingSha256 !== prepared.holderBindingSha256 ||
    (await readOwnedPumpCreateBinding(db, owner, createTerms, signal)) !==
      prepared.deployerBindingSha256
  )
    return fail('Holder funding context changed; prepare a new review.');
  signal.throwIfAborted();
}

/** Complete owned simulation only. A durable review, reservations and explicit browser approval are still required. */
export async function preflightOwnedPumpHolderSimulation(
  db: D1Database,
  owner: string,
  supplied: Terms,
  signal: AbortSignal,
  options: {
    rpc?: PumpLaunchRpc;
    lifetime?: { blockhash: string; lastValidBlockHeight: string };
    captureInput?: (
      input: Parameters<typeof buildPumpCreateHolderMessage>[0],
    ) => void;
  } = {},
) {
  const terms = structuredClone(supplied),
    deadline = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  let input: Parameters<typeof buildPumpCreateHolderMessage>[0] | undefined;
  const prepared = await preflightOwnedPumpHolderFunding(
    db,
    owner,
    terms,
    deadline,
    {
      rpc: options.rpc,
      lifetime: options.lifetime,
      captureInput: (value) => {
        input = value;
      },
    },
  );
  if (!input) return fail('Owned holder simulation context is unavailable.');
  const simulation = await simulatePumpHolderPacket(
    input,
    prepared.allowances,
    prepared.funding,
    prepared.creationSimulation,
    deadline,
    options.rpc,
  );
  if (simulation.packetSha256 !== prepared.packet.packetSha256)
    return fail('Holder simulation packet changed.');
  await assertOwnedHolderContext(db, owner, terms, input, prepared, deadline);
  options.captureInput?.(structuredClone(input));
  return { ...prepared, allWalletSimulation: simulation };
}
