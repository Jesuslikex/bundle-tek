import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { buildPumpCreateHolderMessage } from './pump-holder-message';
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
type CreationEvidence = {
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
export async function collectPumpHolderFunding(
  supplied: Input,
  suppliedAllowances: PumpHolderAllowances,
  suppliedEvidence: CreationEvidence,
  signal: AbortSignal,
  suppliedRpc?: PumpLaunchRpc,
) {
  const input = structuredClone(supplied),
    limits = structuredClone(suppliedAllowances),
    evidence = structuredClone(suppliedEvidence);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  deadline.throwIfAborted();
  // Reconstruct instead of accepting caller-supplied packet bytes or derived buyer accounts.
  const packet = await buildPumpCreateHolderMessage(input, deadline);
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
  const tx = getTransactionDecoder().decode(
      Buffer.from(packet.transaction, 'base64'),
    ),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
    keys = message.staticAccounts.map(String);
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
    if (!methods.has(method) || ++reads > 8)
      throw new Error('Holder funding read budget exceeded.');
    const result = await provider!(method, params, deadline);
    deadline.throwIfAborted();
    return result;
  };
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Holder funding requires Solana mainnet.');
  const feeResult = (await call('getFeeForMessage', [
    Buffer.from(tx.messageBytes).toString('base64'),
    { commitment: 'confirmed', minContextSlot: minimum() },
  ])) as { context?: { slot?: unknown }; value?: unknown };
  observe(feeResult.context?.slot);
  const fee = pumpUnsignedInteger(feeResult.value);
  if (fee === 0n || fee > deployerAllowance)
    throw new Error(
      'Complete holder packet network fee exceeds the deployer allowance.',
    );
  const snapshot = async () => {
    const result = (await call('getMultipleAccounts', [
      keys,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: minimum(),
      },
    ])) as {
      context?: { slot?: unknown };
      value?: unknown[];
    };
    observe(result.context?.slot);
    if (!Array.isArray(result.value) || result.value.length !== keys.length)
      throw new Error('Holder funding account mapping differs.');
    return result.value.map(pumpRpcAccount);
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
    const beforeSha256 = await hash(before[i]);
    if ((await hash(after[i])) !== beforeSha256)
      throw new Error(
        'Holder funding account state changed during observation.',
      );
    accountHashes.push({ address: key, beforeSha256 });
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
  deadline.throwIfAborted();
  return {
    format: 'pump-holder-funding-v1' as const,
    packetSha256: packet.packetSha256,
    allowanceSha256: await hash(limits),
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
  };
}
