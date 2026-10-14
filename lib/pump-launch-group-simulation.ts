import { collectPumpLaunchGroupTrace } from './pump-launch-group-trace';
import { verifyPumpLaunchGroupAccounting } from './pump-launch-group-accounting';
import { buildPumpLaunchPacketGroup } from './pump-launch-packet-group';
import { buildPumpCreateMessage } from './pump-launch-message';
import {
  pumpDeploymentHash,
  pumpGroupProgramDataLink,
  requirePumpGroupDeploymentHeader,
} from './pump-launch-group-deployments';
import { pumpHolderSourceHash } from './pump-holder-source';
import {
  pumpAccountBytes,
  pumpRpcAccount,
  pumpUnsignedInteger,
  type PumpLaunchRpc,
  type PumpRpcAccount,
} from './pump-launch-simulation';
import { requireConsistentSolanaSlots } from './solana-rpc';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

type Input = Parameters<typeof verifyPumpLaunchGroupAccounting>[0];
type Limits = Parameters<typeof verifyPumpLaunchGroupAccounting>[1];
type Evidence = Parameters<typeof verifyPumpLaunchGroupAccounting>[2];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Read-only complete replay and independent economics. Program/transport/authority qualification remains mandatory. */
export async function collectPumpLaunchGroupSimulation(
  supplied: Input,
  suppliedLimits: Limits,
  suppliedFunding: Evidence['funding'],
  suppliedCreation: {
    accountHashes: Evidence['creationAccountHashes'];
    expiresAt: string;
    programDeploymentHashes: { address: string; sha256: string }[];
  },
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const input = structuredClone(supplied),
    limits = structuredClone(suppliedLimits),
    funding = structuredClone(suppliedFunding),
    creation = structuredClone(suppliedCreation),
    deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const expiresAt = creation.expiresAt;
  const current = () => {
    deadline.throwIfAborted();
    if (
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now() ||
      Date.parse(expiresAt) > Date.now() + 60000
    )
      throw new Error(
        'Group simulation evidence expired or has invalid lifetime.',
      );
  };
  current();
  const group = await buildPumpLaunchPacketGroup(input, deadline);
  if (group.packets.length > 5)
    throw new Error('Group simulation requires at most five packets.');
  const chunks = Math.ceil(funding.accountHashes.length / 100);
  let reads = 0,
    replayCount = 0,
    response: unknown;
  const allowed = new Set([
    'getGenesisHash',
    'simulateBundle',
    'getMultipleAccounts',
    'isBlockhashValid',
    'getBlockHeight',
    'getMinimumBalanceForRentExemption',
  ]);
  const call: PumpLaunchRpc = async (method, params) => {
    current();
    if (!allowed.has(method) || ++reads > 36 + 6 * chunks)
      throw new Error('Group simulation read budget exceeded.');
    if (method === 'simulateBundle' && ++replayCount !== 1)
      throw new Error('Group simulation cannot replay a second time.');
    const result = await new Promise<unknown>((resolve, reject) => {
      const cancel = () => reject(deadline.reason);
      deadline.addEventListener('abort', cancel, { once: true });
      Promise.resolve()
        .then(() => {
          current();
          return rpc(method, params, deadline);
        })
        .then(
          (value) => {
            deadline.removeEventListener('abort', cancel);
            resolve(value);
          },
          (error) => {
            deadline.removeEventListener('abort', cancel);
            reject(error);
          },
        );
      if (deadline.aborted) cancel();
    });
    current();
    if (method === 'simulateBundle') response = result;
    return result;
  };
  if ((await call('getGenesisHash', [], deadline)) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Group deployment collection requires mainnet.');
  const created = await buildPumpCreateMessage(input.create);
  const programKeys = [
    ...new Set([
      ...group.packets.flatMap((packet) =>
        packet.instructions.map((ix) => String(ix.programAddress)),
      ),
      ...created.instruction
        .accounts!.slice(7, 10)
        .map((a) => String(a.address)),
      group.quote.tokenProgram,
    ]),
  ];
  if (
    programKeys.length > 64 ||
    !Array.isArray(creation.programDeploymentHashes) ||
    new Set(creation.programDeploymentHashes.map((item) => item.address))
      .size !== creation.programDeploymentHashes.length ||
    creation.programDeploymentHashes.some(
      (item) => !/^[a-f0-9]{64}$/.test(item.sha256),
    )
  )
    throw new Error('Group deployment baseline scope differs.');
  const deploymentSlots = [funding.minimumSlot, funding.maximumSlot];
  const deploymentSnapshot = async (addresses: string[], sliced = false) => {
    if (addresses.length > 100)
      throw new Error('Group deployment snapshot exceeds its bound.');
    const floor = Math.max(...deploymentSlots);
    const value = await call(
      'getMultipleAccounts',
      [
        addresses,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          minContextSlot: floor,
          ...(sliced ? { dataSlice: { offset: 0, length: 45 } } : {}),
        },
      ],
      deadline,
    );
    if (
      !record(value) ||
      !record(value.context) ||
      !Array.isArray(value.value) ||
      value.value.length !== addresses.length
    )
      throw new Error('Group deployment snapshot mapping differs.');
    const slot = Number(pumpUnsignedInteger(value.context.slot));
    if (!Number.isSafeInteger(slot) || slot < floor)
      throw new Error('Group deployment snapshot ignored bank floor.');
    deploymentSlots.push(slot);
    requireConsistentSolanaSlots(deploymentSlots);
    return value.value.map(pumpRpcAccount);
  };
  const programs = await deploymentSnapshot(programKeys);
  for (const [i, address] of programKeys.entries()) {
    const funded = funding.accountHashes.find(
      (item) => item.address === address,
    );
    if (
      !funded ||
      (await pumpDeploymentHash(programs[i])) !== funded.sourceIdentitySha256
    )
      throw new Error('Group executable differs from funded source.');
  }
  const deploymentKeys = [
    ...new Set(
      programKeys.flatMap((address, i) => {
        const link = pumpGroupProgramDataLink(address, programs[i]);
        return link ? [link] : [];
      }),
    ),
  ];
  if (
    creation.programDeploymentHashes.some(
      (item) => !deploymentKeys.includes(item.address),
    )
  )
    throw new Error('Group deployment baseline coverage differs.');
  const deployments = deploymentKeys.length
    ? await deploymentSnapshot(deploymentKeys, true)
    : [];
  for (const [i, account] of deployments.entries()) {
    requirePumpGroupDeploymentHeader(account, funding.maximumSlot);
    const baseline = creation.programDeploymentHashes.find(
      (item) => item.address === deploymentKeys[i],
    );
    if (baseline && (await pumpDeploymentHash(account)) !== baseline.sha256)
      throw new Error('Group deployment changed after creation observation.');
  }
  const trace = await collectPumpLaunchGroupTrace(
    input,
    limits,
    funding,
    expiresAt,
    deadline,
    call,
  );
  const sizes = new Set(
    trace.frames.flatMap((frame) =>
      frame.after.flatMap((account) =>
        account && !account.executable && pumpAccountBytes(account).length
          ? [pumpAccountBytes(account).length]
          : [],
      ),
    ),
  );
  if (sizes.size > 16)
    throw new Error('Group simulation rent-size coverage exceeds its profile.');
  const minimumRentBySize: Evidence['minimumRentBySize'] = {};
  for (const size of sizes) {
    const rent = pumpUnsignedInteger(
      await call(
        'getMinimumBalanceForRentExemption',
        [size, { commitment: 'confirmed' }],
        deadline,
      ),
    );
    if (!rent) throw new Error('Group simulation rent observation differs.');
    minimumRentBySize[String(size)] = rent.toString();
  }
  const accounting = await verifyPumpLaunchGroupAccounting(
    input,
    limits,
    {
      funding,
      response,
      minimumRentBySize,
      creationAccountHashes: creation.accountHashes,
    },
    deadline,
  );
  current();
  const source = {
    quote: group.quote,
    quoteMint: input.create.quoteMint,
    buyerAccounts: group.packets.flatMap((packet) => packet.buyerAccounts),
  };
  const slots = [
    trace.minimumSlot,
    trace.maximumSlot,
    trace.bankSlot,
    ...deploymentSlots,
  ];
  requireConsistentSolanaSlots(slots);
  let sourceRecheckSlot = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const minimum = Math.max(...slots),
      parts: { slot: number; accounts: PumpRpcAccount[] }[] = [];
    for (let i = 0; i < trace.addresses.length; i += 100) {
      const addresses = trace.addresses.slice(i, i + 100),
        value = await call(
          'getMultipleAccounts',
          [
            addresses,
            {
              encoding: 'base64',
              commitment: 'confirmed',
              minContextSlot: minimum,
            },
          ],
          deadline,
        );
      if (
        !record(value) ||
        !record(value.context) ||
        !Array.isArray(value.value) ||
        value.value.length !== addresses.length
      )
        throw new Error('Group simulation final source mapping differs.');
      const slot = Number(pumpUnsignedInteger(value.context.slot));
      if (!Number.isSafeInteger(slot) || slot < minimum)
        throw new Error(
          'Group simulation final source ignored its bank floor.',
        );
      parts.push({ slot, accounts: value.value.map(pumpRpcAccount) });
    }
    slots.push(...parts.map((part) => part.slot));
    requireConsistentSolanaSlots(slots);
    if (parts.some((part) => part.slot !== parts[0].slot)) {
      if (attempt < 2) continue;
      throw new Error('Group simulation final sources do not share one bank.');
    }
    const accounts = parts.flatMap((part) => part.accounts);
    for (const [i, address] of trace.addresses.entries()) {
      current();
      if (
        (await pumpHolderSourceHash(source, address, accounts[i])) !==
        (await pumpHolderSourceHash(source, address, trace.before[i]))
      )
        throw new Error('Group source changed during economic verification.');
    }
    sourceRecheckSlot = parts[0].slot;
    break;
  }
  deploymentSlots.push(...slots);
  if (deploymentKeys.length) {
    const stable = await deploymentSnapshot(deploymentKeys, true);
    for (const [i, account] of stable.entries()) {
      requirePumpGroupDeploymentHeader(account, trace.bankSlot);
      if (
        (await pumpDeploymentHash(account)) !==
        (await pumpDeploymentHash(deployments[i]))
      )
        throw new Error('Group deployment changed during verification.');
    }
    slots.push(...deploymentSlots);
    requireConsistentSolanaSlots(slots);
  }
  const valid = await call(
    'isBlockhashValid',
    [
      input.create.blockhash,
      { commitment: 'confirmed', minContextSlot: Math.max(...slots) },
    ],
    deadline,
  );
  if (!record(valid) || !record(valid.context) || valid.value !== true)
    throw new Error('Group original blockhash became unavailable.');
  const validSlot = Number(pumpUnsignedInteger(valid.context.slot));
  if (!Number.isSafeInteger(validSlot) || validSlot < Math.max(...slots))
    throw new Error('Group validity ignored its final bank floor.');
  slots.push(validSlot);
  requireConsistentSolanaSlots(slots);
  const height = pumpUnsignedInteger(
    await call(
      'getBlockHeight',
      [{ commitment: 'confirmed', minContextSlot: Math.max(...slots) }],
      deadline,
    ),
  );
  if (height + 10n >= input.create.lastValidBlockHeight)
    throw new Error('Group original lifetime expired after accounting.');
  if ((await call('getGenesisHash', [], deadline)) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Group simulation provider network changed.');
  current();
  const report = {
    format: 'pump-launch-group-simulation-v1' as const,
    manifestSha256: group.manifestSha256,
    allowanceSha256: funding.allowanceSha256,
    accounting: { ...accounting, rpcCollectionRequired: false as const },
    sequentialTraceValidated: true as const,
    settlementValidated: true as const,
    rpcCollectionRequired: false as const,
    programDeploymentReviewRequired: true as const,
    programDeploymentMetadataValidated: true as const,
    programDeploymentMetadataOnly: true as const,
    programCodeAttested: false as const,
    programDeploymentHashes: await Promise.all(
      deploymentKeys.map(async (address, i) => ({
        address,
        sha256: await pumpDeploymentHash(deployments[i]),
      })),
    ),
    transportReviewRequired: true as const,
    authorityReviewRequired: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    completeLaunch: false as const,
    bankSlot: trace.bankSlot,
    sourceRecheckSlot,
    minimumSlot: Math.min(...slots),
    maximumSlot: Math.max(...slots),
    networkFeeRaw: trace.networkFeeRaw,
    observedAt: new Date().toISOString(),
    expiresAt,
    reads,
    replayCount,
  };
  current();
  return report;
}
