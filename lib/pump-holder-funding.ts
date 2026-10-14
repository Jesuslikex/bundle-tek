import { buildPumpLaunchPacketGroup } from './pump-launch-packet-group';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { buildPumpCreateHolderMessage } from './pump-holder-message';
import { pumpHolderSourceHash } from './pump-holder-source';
import {
  pumpAccountBytes,
  pumpRpcAccount,
  pumpSystemAccount,
  pumpUnsignedInteger,
  verifyPumpTokenCustody,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import { inspectPumpQuoteMint, PUMP_NATIVE_QUOTE } from './pump-launch-config';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';

type Input = Parameters<typeof buildPumpCreateHolderMessage>[0];
export type PumpHolderAllowances = {
  deployerFeeAndRentLimitRaw: string;
  developerMaximumQuoteCostRaw: string | null;
  holders: {
    address: string;
    feeAndRentLimitRaw: string;
    maximumQuoteCostRaw: string | null;
    minimumTokenOutputRaw: string | null;
  }[];
};
export type PumpHolderCreationEvidence = {
  minimumSlot: number;
  maximumSlot: number;
  accountHashes: { address: string; beforeSha256: string }[];
};
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
const allowance = (value: string, active: boolean) => {
  const n = pumpUnsignedInteger(value);
  if ((active ? n === 0n : n !== 0n) || n > 1000000000n)
    throw new Error(
      'Review each active wallet fee/rent allowance, up to 1 SOL.',
    );
  return n;
};

/** Read-only full-cap funding observation. No simulation, approval, signature or settlement claim. */
async function collectFunding(
  supplied: Input,
  suppliedAllowances: PumpHolderAllowances,
  suppliedEvidence: PumpHolderCreationEvidence,
  signal: AbortSignal,
  suppliedRpc?: PumpLaunchRpc,
  groupMode = false,
) {
  const input = structuredClone(supplied),
    limits = structuredClone(suppliedAllowances),
    evidence = structuredClone(suppliedEvidence);
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(groupMode ? 60000 : 20000),
  ]);
  deadline.throwIfAborted();
  // Reconstruct instead of accepting caller-supplied packet bytes or derived buyer accounts.
  const assembled = groupMode
    ? await buildPumpLaunchPacketGroup(input, deadline)
    : await buildPumpCreateHolderMessage(input, deadline);
  const group = 'packets' in assembled ? assembled : null;
  const packet = group
    ? {
        transaction: group.packets[0].transaction,
        packetSha256: group.manifestSha256,
        quote: group.quote,
        quoteMint: input.create.quoteMint,
        buyerAccounts: group.packets.flatMap((p) => p.buyerAccounts),
      }
    : (assembled as Awaited<ReturnType<typeof buildPumpCreateHolderMessage>>);
  const transactions = group
    ? group.packets.map((p) => p.transaction)
    : [packet.transaction];
  const deployerAllowance = allowance(limits.deployerFeeAndRentLimitRaw, true);
  if (
    limits.developerMaximumQuoteCostRaw !==
      (input.developer?.maximumQuoteCostRaw ?? null) ||
    limits.holders.length !== input.holders.length
  )
    throw new Error(
      'Funding allowances differ from the complete holder packet.',
    );
  for (const [i, holder] of input.holders.entries()) {
    const limit = limits.holders[i];
    allowance(limit.feeAndRentLimitRaw, holder.kind !== 'none');
    if (
      limit.address !== holder.address ||
      limit.maximumQuoteCostRaw !==
        (holder.kind === 'exact-base-output'
          ? holder.maximumQuoteCostRaw
          : null) ||
      limit.minimumTokenOutputRaw !==
        (holder.kind === 'exact-quote-input'
          ? holder.minimumTokenOutputRaw
          : null)
    )
      throw new Error('Funding limits must match every holder slot in order.');
  }
  const decoded = transactions.map((encoded) =>
    getTransactionDecoder().decode(Buffer.from(encoded, 'base64')),
  );
  const keys = [
    ...new Set([
      ...decoded.flatMap((tx) =>
        getCompiledTransactionMessageDecoder()
          .decode(tx.messageBytes)
          .staticAccounts.map(String),
      ),
      ...(groupMode
        ? [
            input.create.global.address,
            input.create.quoteMintAccount?.address,
            input.create.quoteControl?.address,
          ].filter((key): key is string => key !== undefined)
        : []),
    ]),
  ];
  if (keys.length > 2048)
    throw new Error('Launch group account observation exceeds its bound.');
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += 100)
    chunks.push(keys.slice(i, i + 100));
  if (groupMode) {
    if (
      !Array.isArray(evidence.accountHashes) ||
      evidence.accountHashes.length > 64 ||
      new Set(evidence.accountHashes.map((a) => a?.address)).size !==
        evidence.accountHashes.length ||
      evidence.accountHashes.some(
        (a) =>
          !a ||
          typeof a.address !== 'string' ||
          !/^[a-f0-9]{64}$/.test(a.beforeSha256),
      ) ||
      [input.create.global.address, input.create.payer, input.create.mint].some(
        (key) => !evidence.accountHashes.some((a) => a.address === key),
      )
    )
      throw new Error(
        'Review complete creation evidence before group funding.',
      );
    if (
      evidence.accountHashes.some(
        (a) =>
          !keys.includes(a.address) &&
          a.address !== 'ComputeBudget111111111111111111111111111111',
      )
    )
      throw new Error(
        'Creation evidence is outside the launch group account scope.',
      );
  }
  const slots = [evidence.minimumSlot, evidence.maximumSlot];
  requireConsistentSolanaSlots(slots);
  const minimum = () => Math.max(...slots);
  const observe = (value: unknown) => {
    const slot = Number(pumpUnsignedInteger(value));
    if (!Number.isSafeInteger(slot) || slot < minimum())
      throw new Error('Holder funding RPC ignored its context slot.');
    slots.push(slot);
    requireConsistentSolanaSlots(slots);
    return slot;
  };
  let provider = suppliedRpc;
  if (!provider) {
    const endpoint = getSolanaIndexerRpcEndpoint(),
      url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('Holder funding RPC requires HTTPS.');
    provider = (method, params, abort) =>
      balanceRpc(endpoint, method, params, abort, fetch, 2097152);
  }
  const methods = new Set([
    'getGenesisHash',
    'getFeeForMessage',
    'getMultipleAccounts',
    'isBlockhashValid',
    'getBlockHeight',
  ]);
  let reads = 0;
  const call = async (method: string, params: unknown[]) => {
    deadline.throwIfAborted();
    if (
      !methods.has(method) ||
      ++reads > (groupMode ? 4 + decoded.length + 6 * chunks.length : 8)
    )
      throw new Error('Holder funding read budget exceeded.');
    const result = await new Promise<unknown>((resolve, reject) => {
      const cancel = () => reject(deadline.reason);
      deadline.addEventListener('abort', cancel, { once: true });
      Promise.resolve()
        .then(() => {
          deadline.throwIfAborted();
          return provider!(method, params, deadline);
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
    deadline.throwIfAborted();
    return result;
  };
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Holder funding requires Solana mainnet.');
  const packetFees: { index: number; networkFeeRaw: string }[] = [];
  let fee = 0n;
  for (const [index, tx] of decoded.entries()) {
    const result = (await call('getFeeForMessage', [
      Buffer.from(tx.messageBytes).toString('base64'),
      { commitment: 'confirmed', minContextSlot: minimum() },
    ])) as { context?: { slot?: unknown }; value?: unknown };
    observe(result.context?.slot);
    const amount = pumpUnsignedInteger(result.value);
    if (amount === 0n) throw new Error('Launch packet fee is unavailable.');
    fee += amount;
    packetFees.push({ index, networkFeeRaw: amount.toString() });
    if (fee > deployerAllowance)
      throw new Error(
        'Complete holder packet/group network fees exceed the deployer allowance.',
      );
  }
  const snapshotSlots: number[] = [];
  const snapshot = async () => {
    for (let attempt = 0; attempt < (groupMode ? 3 : 1); attempt++) {
      const requested = minimum();
      const parts = await Promise.all(
        chunks.map(async (chunk) => {
          const result = (await call('getMultipleAccounts', [
            chunk,
            {
              encoding: 'base64',
              commitment: 'confirmed',
              minContextSlot: requested,
            },
          ])) as { context?: { slot?: unknown }; value?: unknown[] };
          const slot = Number(pumpUnsignedInteger(result.context?.slot));
          if (!Number.isSafeInteger(slot) || slot < requested)
            throw new Error('Holder funding RPC ignored its context slot.');
          if (
            !Array.isArray(result.value) ||
            result.value.length !== chunk.length
          )
            throw new Error('Holder funding account mapping differs.');
          return { slot, accounts: result.value.map(pumpRpcAccount) };
        }),
      );
      slots.push(...parts.map((p) => p.slot));
      requireConsistentSolanaSlots(slots);
      if (parts.some((p) => p.slot !== parts[0].slot)) {
        if (attempt < 2) continue;
        throw new Error(
          'Group funding snapshots do not share one reported bank.',
        );
      }
      snapshotSlots.push(parts[0].slot);
      return parts.flatMap((p) => p.accounts);
    }
    throw new Error('Group funding snapshot is unavailable.');
  };
  const before = await snapshot();
  const at = (key: string) => {
    const index = keys.indexOf(key);
    if (index < 0) throw new Error('Holder funding packet account is missing.');
    return before[index];
  };
  for (const item of evidence.accountHashes) {
    if (item.address === 'ComputeBudget111111111111111111111111111111')
      continue;
    if ((await hash(at(item.address))) !== item.beforeSha256)
      throw new Error('Creation state changed before holder funding checks.');
  }
  if (groupMode) {
    if (at(input.create.mint) !== null)
      throw new Error(
        'Group creation mint already exists. Recover the original launch first.',
      );
    for (const expected of [
      input.create.global,
      input.create.quoteMintAccount,
      input.create.quoteControl,
    ].filter((a) => a !== undefined)) {
      const observed = at(expected.address);
      if (
        !observed ||
        observed.owner !== expected.owner ||
        observed.executable !== expected.executable ||
        !Buffer.from(pumpAccountBytes(observed)).equals(
          Buffer.from(expected.data),
        )
      )
        throw new Error(
          'Group creation configuration differs from its account bank.',
        );
    }
  }
  const native = input.create.quoteMint === PUMP_NATIVE_QUOTE,
    mint = at(input.create.quoteMint);
  if (!mint) throw new Error('Holder quote mint is unavailable.');
  const details = inspectPumpQuoteMint({
    address: input.create.quoteMint,
    owner: mint.owner,
    executable: mint.executable,
    data: pumpAccountBytes(mint),
    slot: minimum(),
  });
  if (
    details.tokenProgram !== packet.quote.tokenProgram ||
    details.decimals !== packet.quote.decimals
  )
    throw new Error('Holder funding quote precision or token program differs.');
  const buyers = new Map<string, (typeof packet.buyerAccounts)[number]>(
    packet.buyerAccounts.map((b) => [b.payer, b]),
  );
  const rows: {
    address: string;
    active: boolean;
    quoteLimitRaw: string;
    feeAndRentLimitRaw: string;
    requiredSolRaw: string;
    observedSolRaw: string | null;
    observedQuoteRaw: string | null;
  }[] = [];
  const check = (
    address: string,
    quoteLimit: bigint,
    feeAndRent: bigint,
    active: boolean,
  ) => {
    if (!active) {
      rows.push({
        address,
        active,
        quoteLimitRaw: '0',
        feeAndRentLimitRaw: '0',
        requiredSolRaw: '0',
        observedSolRaw: null,
        observedQuoteRaw: null,
      });
      return;
    }
    const account = at(address),
      sol = account ? pumpUnsignedInteger(account.lamports) : 0n,
      required = feeAndRent + (native ? quoteLimit : 0n);
    if (!pumpSystemAccount(account) || sol < required)
      throw new Error(
        `Wallet ${address} needs its full SOL buy and fee/rent allowances.`,
      );
    const buyer = buyers.get(address);
    let quote: bigint | null = null;
    if (quoteLimit > 0n) {
      if (!buyer || at(buyer.userBaseAccount) !== null)
        throw new Error(
          'Holder destination token account already exists or is missing from the packet.',
        );
      if (!native) {
        const source = at(buyer.userQuoteAccount);
        if (!source || pumpAccountBytes(source).length < 165)
          throw new Error(
            `Wallet ${address} quote-token custody is unavailable.`,
          );
        quote = new DataView(pumpAccountBytes(source).buffer).getBigUint64(
          64,
          true,
        );
        verifyPumpTokenCustody(source, {
          program: packet.quote.tokenProgram,
          mint: input.create.quoteMint,
          owner: address,
          amount: quote,
        });
        if (quote < quoteLimit)
          throw new Error(
            `Wallet ${address} needs its full quote-token allowance.`,
          );
      }
    }
    rows.push({
      address,
      active,
      quoteLimitRaw: quoteLimit.toString(),
      feeAndRentLimitRaw: feeAndRent.toString(),
      requiredSolRaw: required.toString(),
      observedSolRaw: sol.toString(),
      observedQuoteRaw: quote?.toString() ?? null,
    });
  };
  check(
    input.create.payer,
    pumpUnsignedInteger(input.developer?.maximumQuoteCostRaw ?? '0'),
    deployerAllowance,
    true,
  );
  for (const [i, holder] of input.holders.entries()) {
    check(
      holder.address,
      pumpUnsignedInteger(
        holder.kind === 'none'
          ? '0'
          : holder.kind === 'exact-base-output'
            ? holder.maximumQuoteCostRaw
            : holder.quoteAmountRaw,
      ),
      pumpUnsignedInteger(limits.holders[i].feeAndRentLimitRaw),
      holder.kind !== 'none',
    );
  }
  const after = await snapshot(),
    accountHashes = [];
  for (const [i, key] of keys.entries()) {
    deadline.throwIfAborted();
    const beforeSha256 = await hash(before[i]);
    const sourceIdentitySha256 = await pumpHolderSourceHash(
      packet,
      key,
      before[i],
    );
    if (
      (await pumpHolderSourceHash(packet, key, after[i])) !==
      sourceIdentitySha256
    )
      throw new Error(
        'Holder funding account state changed during observation.',
      );
    accountHashes.push({ address: key, beforeSha256, sourceIdentitySha256 });
  }
  const validity = (await call('isBlockhashValid', [
    input.create.blockhash,
    { commitment: 'confirmed', minContextSlot: minimum() },
  ])) as { context?: { slot?: unknown }; value?: unknown };
  observe(validity.context?.slot);
  const height = pumpUnsignedInteger(
    await call('getBlockHeight', [
      { commitment: 'confirmed', minContextSlot: minimum() },
    ]),
  );
  if (
    validity.value !== true ||
    height + 10n >= input.create.lastValidBlockHeight
  )
    throw new Error(
      'Holder funding packet blockhash is expired or too close to expiry.',
    );
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Holder funding RPC network changed.');
  const allowanceSha256 = await hash(limits);
  deadline.throwIfAborted();
  return {
    report: {
      format: 'pump-holder-funding-v1' as const,
      packetSha256: packet.packetSha256,
      allowanceSha256,
      networkFeeRaw: fee.toString(),
      wallets: rows,
      accountHashes,
      minimumSlot: Math.min(...slots),
      maximumSlot: Math.max(...slots),
      fundingValidated: true as const,
      settlementValidated: false as const,
      simulationRequired: true as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      completeLaunch: false as const,
    },
    packetFees,
    snapshotSlots,
  };
}

/** Reconstructs and checks one complete packet. Preserves the existing public report. */
export async function collectPumpHolderFunding(
  input: Input,
  limits: PumpHolderAllowances,
  evidence: PumpHolderCreationEvidence,
  signal: AbortSignal,
  rpc?: PumpLaunchRpc,
) {
  return (await collectFunding(input, limits, evidence, signal, rpc)).report;
}

/** Read-only complete group funding; never claims sequential simulation or execution readiness. */
export async function collectPumpLaunchGroupFunding(
  input: Input,
  limits: PumpHolderAllowances,
  evidence: PumpHolderCreationEvidence,
  signal: AbortSignal,
  rpc?: PumpLaunchRpc,
) {
  const observed = await collectFunding(
    input,
    limits,
    evidence,
    signal,
    rpc,
    true,
  );
  const { packetSha256, ...report } = observed.report;
  return {
    ...report,
    format: 'pump-launch-group-funding-v1' as const,
    manifestSha256: packetSha256,
    packetFees: observed.packetFees,
    sourceBankSlots: {
      before: observed.snapshotSlots[0],
      after: observed.snapshotSlots[1],
    },
    snapshotBankMatched: true as const,
    sequentialSimulationRequired: true as const,
  };
}
