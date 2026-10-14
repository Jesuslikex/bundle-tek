import bs58 from 'bs58';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { buildPumpCreateHolderMessage } from './pump-holder-message';
import { buildPumpCreateMessage } from './pump-launch-message';
import {
  collectPumpHolderFunding,
  type PumpHolderAllowances,
} from './pump-holder-funding';
import { verifyPumpHolderSettlement } from './pump-holder-settlement';
import {
  pumpRpcAccount,
  pumpAccountBytes,
  pumpUnsignedInteger,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';

type Input = Parameters<typeof buildPumpCreateHolderMessage>[0];
type Funding = Awaited<ReturnType<typeof collectPumpHolderFunding>>;
type Creation = Parameters<
  typeof verifyPumpHolderSettlement
>[2]['creationAccountHashes'];
const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const hash = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');

/** Complete unsigned simulation, bounded source/deployment collection and independent per-wallet settlement checks. */
export async function simulatePumpHolderPacket(
  supplied: Input,
  suppliedLimits: PumpHolderAllowances,
  suppliedFunding: Funding,
  suppliedCreation: {
    accountHashes: Creation;
    programDeploymentHashes: { address: string; sha256: string }[];
    expiresAt: string;
  },
  signal: AbortSignal,
  suppliedRpc?: PumpLaunchRpc,
) {
  const input = structuredClone(supplied),
    limits = structuredClone(suppliedLimits),
    funding = structuredClone(suppliedFunding),
    creation = structuredClone(suppliedCreation),
    deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const current = () => {
    deadline.throwIfAborted();
    if (
      !Number.isFinite(Date.parse(creation.expiresAt)) ||
      Date.parse(creation.expiresAt) <= Date.now()
    )
      throw new Error('Holder creation observation expired; prepare again.');
  };
  current();
  const packet = await buildPumpCreateHolderMessage(input, deadline),
    created = await buildPumpCreateMessage(input.create),
    tx = getTransactionDecoder().decode(
      Buffer.from(packet.transaction, 'base64'),
    ),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
    keys = message.staticAccounts.map(String);
  if (
    funding.packetSha256 !== packet.packetSha256 ||
    funding.allowanceSha256 !== (await hash(limits)) ||
    funding.accountHashes.length !== keys.length ||
    funding.accountHashes.some((item, i) => item.address !== keys[i])
  )
    throw new Error('Holder simulation funding context differs.');
  const slots = [funding.minimumSlot, funding.maximumSlot];
  requireConsistentSolanaSlots(slots);
  const minimum = () => Math.max(...slots),
    observe = (value: unknown) => {
      const slot = Number(pumpUnsignedInteger(value));
      if (!Number.isSafeInteger(slot) || slot < minimum())
        throw new Error('Holder simulation RPC ignored its context slot.');
      slots.push(slot);
      requireConsistentSolanaSlots(slots);
      return slot;
    };
  let provider = suppliedRpc,
    reads = 0;
  if (!provider) {
    const endpoint = getSolanaIndexerRpcEndpoint(),
      url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('Holder simulation requires HTTPS RPC.');
    provider = (method, params, abort) =>
      balanceRpc(endpoint, method, params, abort, fetch, 2097152);
  }
  const methods = new Set([
    'getGenesisHash',
    'getMultipleAccounts',
    'getFeeForMessage',
    'getMinimumBalanceForRentExemption',
    'simulateTransaction',
    'isBlockhashValid',
    'getBlockHeight',
  ]);
  const call = async (method: string, params: unknown[]) => {
    current();
    if (!methods.has(method) || ++reads > 32)
      throw new Error('Holder simulation RPC budget exceeded.');
    const result = await provider!(method, params, deadline);
    current();
    return result;
  };
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Holder simulation requires Solana mainnet.');
  const snapshot = async (addresses: string[], sliced = false) => {
    const result = (await call('getMultipleAccounts', [
      addresses,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: minimum(),
        ...(sliced ? { dataSlice: { offset: 0, length: 45 } } : {}),
      },
    ])) as { context?: { slot?: unknown }; value?: unknown[] };
    observe(result.context?.slot);
    if (
      !Array.isArray(result.value) ||
      result.value.length !== addresses.length
    )
      throw new Error('Holder simulation source mapping differs.');
    return result.value.map(pumpRpcAccount);
  };
  const before = await snapshot(keys),
    at = (key: string) => {
      const i = keys.indexOf(key);
      if (i < 0)
        throw new Error('Holder simulation executable account is missing.');
      return before[i];
    };
  for (const [i, item] of funding.accountHashes.entries())
    if ((await hash(before[i])) !== item.beforeSha256)
      throw new Error('Holder funding changed before simulation.');
  const programKeys = new Set([
      ...packet.instructions.map((ix) => String(ix.programAddress)),
      ...created.instruction
        .accounts!.slice(7, 10)
        .map((a) => String(a.address)),
      packet.quote.tokenProgram,
    ]),
    dataKeys = new Set<string>();
  for (const key of programKeys) {
    const account = at(key);
    if (
      !account?.executable ||
      ![UPGRADEABLE, 'BPFLoader2111111111111111111111111111111111'].includes(
        account.owner,
      )
    )
      throw new Error('Holder simulation executable or loader differs.');
    if (account.owner === UPGRADEABLE) {
      const data = pumpAccountBytes(account);
      if (
        data.length !== 36 ||
        new DataView(data.buffer).getUint32(0, true) !== 2
      )
        throw new Error('Holder simulation program deployment link differs.');
      dataKeys.add(bs58.encode(data.slice(4)));
    }
  }
  if (
    creation.programDeploymentHashes.some((item) => !dataKeys.has(item.address))
  )
    throw new Error('Holder simulation deployment coverage differs.');
  const deploymentKeys = [...dataKeys],
    deployments = deploymentKeys.length
      ? await snapshot(deploymentKeys, true)
      : [];
  for (const [i, account] of deployments.entries()) {
    if (!account || account.executable || account.owner !== UPGRADEABLE)
      throw new Error('Holder simulation deployment metadata differs.');
    const data = pumpAccountBytes(account),
      view = new DataView(data.buffer),
      baseline = creation.programDeploymentHashes.find(
        (item) => item.address === deploymentKeys[i],
      );
    if (
      data.length !== 45 ||
      view.getUint32(0, true) !== 3 ||
      data[12] > 1 ||
      view.getBigUint64(4, true) > BigInt(minimum()) ||
      (baseline && (await hash(account)) !== baseline.sha256)
    )
      throw new Error('Holder program changed after creation simulation.');
  }
  const feeResult = (await call('getFeeForMessage', [
    Buffer.from(tx.messageBytes).toString('base64'),
    { commitment: 'confirmed', minContextSlot: minimum() },
  ])) as { context?: { slot?: unknown }; value?: unknown };
  observe(feeResult.context?.slot);
  const fee = pumpUnsignedInteger(feeResult.value);
  if (!fee || fee.toString() !== funding.networkFeeRaw)
    throw new Error(
      'Holder simulation network fee changed after funding checks.',
    );
  const result = (await call('simulateTransaction', [
    packet.transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: minimum(),
      accounts: { encoding: 'base64', addresses: keys },
      innerInstructions: false,
    },
  ])) as {
    context?: { slot?: unknown };
    value?: {
      err?: unknown;
      accounts?: unknown[];
      fee?: unknown;
      replacementBlockhash?: unknown;
      unitsConsumed?: unknown;
      loadedAccountsDataSize?: unknown;
    };
  };
  const simulationSlot = observe(result.context?.slot),
    value = result.value;
  if (!value || value.err !== null)
    throw new Error(
      'Complete Pump holder simulation failed. No approval was created.',
    );
  if (
    value.replacementBlockhash != null ||
    (value.fee != null && pumpUnsignedInteger(value.fee) !== fee) ||
    !Array.isArray(value.accounts) ||
    value.accounts.length !== keys.length
  )
    throw new Error(
      'Holder simulation fee, lifetime or account mapping differs.',
    );
  const units = pumpUnsignedInteger(value.unitsConsumed);
  if (
    !units ||
    units > 1400000n ||
    (value.loadedAccountsDataSize != null &&
      pumpUnsignedInteger(value.loadedAccountsDataSize) > 67108864n)
  )
    throw new Error('Holder simulation exceeded its resource limits.');
  const after = value.accounts.map(pumpRpcAccount),
    minimumRentBySize: Record<string, string> = {};
  for (const account of after) {
    if (!account || account.executable) continue;
    const size = pumpAccountBytes(account).length;
    if (size && minimumRentBySize[String(size)] === undefined)
      minimumRentBySize[String(size)] = pumpUnsignedInteger(
        await call('getMinimumBalanceForRentExemption', [
          size,
          { commitment: 'confirmed' },
        ]),
      ).toString();
  }
  const accounting = await verifyPumpHolderSettlement(input, limits, {
    addresses: keys,
    before,
    after,
    networkFeeRaw: fee.toString(),
    minimumRentBySize,
    creationAccountHashes: creation.accountHashes,
  });
  const stable = await snapshot(keys);
  for (const [i, account] of stable.entries())
    if ((await hash(account)) !== funding.accountHashes[i].beforeSha256)
      throw new Error('Holder source state changed during simulation.');
  if (deploymentKeys.length) {
    const stableDeployments = await snapshot(deploymentKeys, true);
    for (const [i, account] of stableDeployments.entries())
      if ((await hash(account)) !== (await hash(deployments[i])))
        throw new Error('Holder program changed during simulation.');
  }
  const valid = (await call('isBlockhashValid', [
    input.create.blockhash,
    { commitment: 'confirmed', minContextSlot: minimum() },
  ])) as { context?: { slot?: unknown }; value?: unknown };
  observe(valid.context?.slot);
  const height = pumpUnsignedInteger(
    await call('getBlockHeight', [
      { commitment: 'confirmed', minContextSlot: minimum() },
    ]),
  );
  if (valid.value !== true || height + 10n >= input.create.lastValidBlockHeight)
    throw new Error('Holder simulation blockhash expired or is near expiry.');
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Holder simulation network changed.');
  current();
  const report = {
    format: 'pump-holder-simulation-v1' as const,
    status: 'Simulated' as const,
    packetSha256: packet.packetSha256,
    slot: simulationSlot,
    minimumSlot: Math.min(...slots),
    maximumSlot: Math.max(...slots),
    observedAt: new Date().toISOString(),
    expiresAt: new Date(
      Math.min(Date.parse(creation.expiresAt), Date.now() + 60000),
    ).toISOString(),
    networkFeeRaw: fee.toString(),
    unitsConsumed: units.toString(),
    reads,
    accounting: { ...accounting, rpcCollectionRequired: false as const },
    settlementValidated: true as const,
    programDeploymentMetadataOnly: true as const,
    authorityReviewRequired: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    completeLaunch: false as const,
    accountHashes: await Promise.all(
      keys.map(async (address, i) => ({
        address,
        beforeSha256: await hash(before[i]),
        simulatedSha256: await hash(after[i]),
      })),
    ),
    programDeploymentHashes: await Promise.all(
      deploymentKeys.map(async (address, i) => ({
        address,
        sha256: await hash(deployments[i]),
      })),
    ),
  };
  current();
  return report;
}
