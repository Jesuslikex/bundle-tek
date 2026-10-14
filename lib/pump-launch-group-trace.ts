import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { buildPumpLaunchPacketGroup } from './pump-launch-packet-group';
import type { PumpHolderMessageInput } from './pump-holder-message';
import type {
  PumpHolderAllowances,
  collectPumpLaunchGroupFunding,
} from './pump-holder-funding';
import {
  pumpRpcAccount,
  pumpUnsignedInteger,
  pumpSystemAccount,
  pumpAccountBytes,
  verifyPumpTokenCustody,
  type PumpRpcAccount,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import { pumpHolderSourceHash } from './pump-holder-source';
import { requireConsistentSolanaSlots } from './solana-rpc';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { PUMP_NATIVE_QUOTE } from './pump-launch-config';
type Funding = Awaited<ReturnType<typeof collectPumpLaunchGroupFunding>>;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
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
const slot = (value: unknown) => {
  const n = Number(pumpUnsignedInteger(value));
  if (!Number.isSafeInteger(n)) throw new Error('Bundle bank slot is invalid.');
  return n;
};
/** Jito's account overlay encodes missing accounts as the default zero-lamport system account. */
function bundleAccount(value: unknown): PumpRpcAccount {
  const account = pumpRpcAccount(value);
  return account &&
    account.owner === '11111111111111111111111111111111' &&
    !account.executable &&
    account.lamports === '0' &&
    account.data[0] === ''
    ? null
    : account;
}
async function plan(
  supplied: PumpHolderMessageInput,
  suppliedLimits: PumpHolderAllowances,
  suppliedFunding: Funding,
  signal?: AbortSignal,
) {
  const input = structuredClone(supplied),
    limits = structuredClone(suppliedLimits),
    funding = structuredClone(suppliedFunding),
    group = await buildPumpLaunchPacketGroup(input, signal);
  signal?.throwIfAborted();
  if (group.packets.length > 5)
    throw new Error(
      'This group exceeds one five-transaction bundle. Review an explicit execution policy; no partial simulation was requested.',
    );
  const messages = group.packets.map((p) =>
    getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'))
        .messageBytes,
    ),
  );
  const staticKeys = messages.map((m) => m.staticAccounts.map(String));
  const extras = [
    input.create.global.address,
    input.create.quoteMintAccount?.address,
    input.create.quoteControl?.address,
  ].filter((key): key is string => key !== undefined);
  const keys = [...new Set([...staticKeys.flat(), ...extras])];
  if (
    funding.format !== 'pump-launch-group-funding-v1' ||
    funding.fundingValidated !== true ||
    funding.signingAllowed !== false ||
    funding.executionAllowed !== false ||
    funding.manifestSha256 !== group.manifestSha256 ||
    funding.allowanceSha256 !== (await hash(limits)) ||
    funding.snapshotBankMatched !== true ||
    funding.accountHashes.length !== keys.length ||
    funding.accountHashes.some(
      (a, i) =>
        a.address !== keys[i] || !/^[a-f0-9]{64}$/.test(a.sourceIdentitySha256),
    ) ||
    funding.packetFees.length !== group.packets.length ||
    funding.packetFees.some(
      (f, i) => f.index !== i || pumpUnsignedInteger(f.networkFeeRaw) === 0n,
    )
  )
    throw new Error('Bundle trace funding context differs.');
  const fee = funding.packetFees.reduce(
    (sum, p) => sum + pumpUnsignedInteger(p.networkFeeRaw),
    0n,
  );
  if (
    fee !== pumpUnsignedInteger(funding.networkFeeRaw) ||
    fee > pumpUnsignedInteger(limits.deployerFeeAndRentLimitRaw)
  )
    throw new Error('Bundle trace fee limits differ.');
  requireConsistentSolanaSlots([
    funding.minimumSlot,
    funding.maximumSlot,
    funding.sourceBankSlots.before,
    funding.sourceBankSlots.after,
  ]);
  if (
    funding.sourceBankSlots.before > funding.sourceBankSlots.after ||
    funding.maximumSlot < funding.sourceBankSlots.after
  )
    throw new Error('Bundle trace source banks differ.');
  const tracked = staticKeys.map((keys) => [...keys]);
  for (const extra of keys.filter((k) => !staticKeys.flat().includes(k))) {
    const carrier = tracked.find((keys) => keys.length < 64);
    if (!carrier)
      throw new Error(
        'Complete configuration snapshots exceed the bundle profile bound.',
      );
    carrier.push(extra);
  }
  const source = {
    quote: group.quote,
    quoteMint: input.create.quoteMint,
    buyerAccounts: group.packets.flatMap((p) => p.buyerAccounts),
  };
  if (
    limits.holders.length !== input.holders.length ||
    limits.developerMaximumQuoteCostRaw !==
      (input.developer?.maximumQuoteCostRaw ?? null)
  )
    throw new Error('Bundle trace allowance slots differ.');
  const deployerLimit = pumpUnsignedInteger(limits.deployerFeeAndRentLimitRaw);
  if (!deployerLimit || deployerLimit > 1000000000n)
    throw new Error('Bundle deployer allowance differs.');
  for (const [i, h] of input.holders.entries()) {
    const limit = limits.holders[i],
      amount = pumpUnsignedInteger(limit.feeAndRentLimitRaw);
    if (
      limit.address !== h.address ||
      limit.maximumQuoteCostRaw !==
        (h.kind === 'exact-base-output' ? h.maximumQuoteCostRaw : null) ||
      limit.minimumTokenOutputRaw !==
        (h.kind === 'exact-quote-input' ? h.minimumTokenOutputRaw : null) ||
      (h.kind === 'none'
        ? amount !== 0n
        : amount === 0n || amount > 1000000000n)
    )
      throw new Error('Bundle trace holder limits differ from saved intents.');
  }
  if (funding.minimumSlot > funding.sourceBankSlots.before)
    throw new Error('Bundle trace source range differs.');
  return {
    input,
    limits,
    funding,
    group,
    messages,
    staticKeys,
    tracked,
    keys,
    source,
    fee,
    bank: funding.maximumSlot,
  };
}
type Plan = Awaited<ReturnType<typeof plan>>;
async function verify(p: Plan, response: unknown, signal?: AbortSignal) {
  const encoded = JSON.stringify(response);
  if (!encoded || new TextEncoder().encode(encoded).byteLength > 4194304)
    throw new Error('Bundle trace exceeds its response bound.');
  const raw: unknown = JSON.parse(encoded);
  if (
    !record(raw) ||
    !record(raw.context) ||
    slot(raw.context.slot) !== p.bank ||
    !record(raw.value) ||
    raw.value.summary !== 'succeeded' ||
    !Array.isArray(raw.value.transactionResults) ||
    raw.value.transactionResults.length !== p.group.packets.length
  )
    throw new Error(
      'Complete bundle simulation failed or used a different bank.',
    );
  const initial = new Map<string, PumpRpcAccount>(),
    state = new Map<string, PumpRpcAccount>(),
    frames = [];
  for (const [index, packet] of p.group.packets.entries()) {
    signal?.throwIfAborted();
    const result = raw.value.transactionResults[index];
    if (
      !record(result) ||
      result.err !== null ||
      result.replacementBlockhash != null ||
      !Array.isArray(result.preExecutionAccounts) ||
      !Array.isArray(result.postExecutionAccounts) ||
      result.preExecutionAccounts.length !== p.tracked[index].length ||
      result.postExecutionAccounts.length !== p.tracked[index].length
    )
      throw new Error(
        'Bundle packet status, lifetime or account mapping differs.',
      );
    if (
      result.loadedAddresses != null &&
      (!record(result.loadedAddresses) ||
        !Array.isArray(result.loadedAddresses.writable) ||
        !Array.isArray(result.loadedAddresses.readonly) ||
        result.loadedAddresses.writable.length !== 0 ||
        result.loadedAddresses.readonly.length !== 0)
    )
      throw new Error('Bundle v1 trace claims unexpected lookup accounts.');
    const units = pumpUnsignedInteger(result.unitsConsumed),
      data = pumpUnsignedInteger(result.loadedAccountsDataSize),
      fee = pumpUnsignedInteger(result.fee);
    if (
      !units ||
      units > 1400000n ||
      data > 67108864n ||
      fee.toString() !== p.funding.packetFees[index].networkFeeRaw
    )
      throw new Error('Bundle packet fee or resources differ.');
    const before = result.preExecutionAccounts.map(bundleAccount),
      after = result.postExecutionAccounts.map(bundleAccount);
    for (const [i, key] of p.tracked[index].entries()) {
      signal?.throwIfAborted();
      if (state.has(key)) {
        if ((await hash(state.get(key))) !== (await hash(before[i])))
          throw new Error(
            'Bundle state did not carry across packet boundaries.',
          );
      } else {
        const baseline = p.funding.accountHashes.find(
          (a) => a.address === key,
        )!;
        if (
          (await pumpHolderSourceHash(p.source, key, before[i])) !==
          baseline.sourceIdentitySha256
        )
          throw new Error('Bundle initial state differs from funded sources.');
        initial.set(key, before[i]);
      }
      const position = p.staticKeys[index].indexOf(key),
        header = p.messages[index].header;
      const writable =
        position >= 0 &&
        (position <
          header.numSignerAccounts - header.numReadonlySignerAccounts ||
          (position >= header.numSignerAccounts &&
            position <
              p.staticKeys[index].length -
                header.numReadonlyNonSignerAccounts));
      if (
        (!writable || before[i]?.executable) &&
        (await hash(before[i])) !== (await hash(after[i]))
      )
        throw new Error(
          'Bundle packet changed a readonly or executable account.',
        );
      state.set(key, after[i]);
    }
    frames.push({
      index,
      packetSha256: packet.packetSha256,
      networkFeeRaw: fee.toString(),
      unitsConsumed: units.toString(),
      loadedAccountsDataSize: data.toString(),
      addresses: p.tracked[index],
      before,
      after,
    });
  }
  if (initial.size !== p.keys.length || state.size !== p.keys.length)
    throw new Error('Bundle trace omitted group accounts.');
  const native = p.input.create.quoteMint === PUMP_NATIVE_QUOTE;
  const terms = [
    {
      address: p.input.create.payer,
      quote: p.input.developer?.maximumQuoteCostRaw ?? '0',
      fee: p.limits.deployerFeeAndRentLimitRaw,
    },
    ...p.input.holders.flatMap((h, i) =>
      h.kind === 'none'
        ? []
        : [
            {
              address: h.address,
              quote:
                h.kind === 'exact-base-output'
                  ? h.maximumQuoteCostRaw
                  : h.quoteAmountRaw,
              fee: p.limits.holders[i].feeAndRentLimitRaw,
            },
          ],
    ),
  ];
  for (const term of terms) {
    const wallet = initial.get(term.address)!,
      quote = pumpUnsignedInteger(term.quote),
      required = pumpUnsignedInteger(term.fee) + (native ? quote : 0n);
    if (
      !pumpSystemAccount(wallet) ||
      pumpUnsignedInteger(wallet!.lamports) < required
    )
      throw new Error(
        'Bundle initial wallet does not cover its full reviewed cap.',
      );
    if (quote > 0n) {
      const buyer = p.source.buyerAccounts.find(
        (b) => b.payer === term.address,
      )!;
      if (initial.get(buyer.userBaseAccount) !== null)
        throw new Error('Bundle initial destination custody already exists.');
      if (!native) {
        const account = initial.get(buyer.userQuoteAccount)!;
        if (!account || pumpAccountBytes(account).length < 165)
          throw new Error('Bundle initial quote custody is unavailable.');
        const bytes = pumpAccountBytes(account),
          amount = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          ).getBigUint64(64, true);
        verifyPumpTokenCustody(account, {
          program: p.group.quote.tokenProgram,
          mint: p.input.create.quoteMint,
          owner: term.address,
          amount,
        });
        if (amount < quote)
          throw new Error(
            'Bundle initial quote does not cover its full reviewed cap.',
          );
      }
    }
  }
  const result = {
    format: 'pump-launch-group-trace-v1' as const,
    manifestSha256: p.group.manifestSha256,
    allowanceSha256: p.funding.allowanceSha256,
    bankSlot: p.bank,
    networkFeeRaw: p.fee.toString(),
    addresses: p.keys,
    before: p.keys.map((k) => initial.get(k)!),
    after: p.keys.map((k) => state.get(k)!),
    frames,
    sequentialTraceValidated: true as const,
    economicVerificationRequired: true as const,
    programDeploymentReviewRequired: true as const,
    rpcCollectionRequired: true,
    settlementValidated: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    completeLaunch: false as const,
    transportReviewRequired: true as const,
  };
  signal?.throwIfAborted();
  return result;
}
/** Validates a retained producer trace. Does not turn fixture/account data into economic or runtime proof. */
export async function verifyPumpLaunchGroupTrace(
  input: PumpHolderMessageInput,
  limits: PumpHolderAllowances,
  funding: Funding,
  response: unknown,
  signal?: AbortSignal,
) {
  return verify(await plan(input, limits, funding, signal), response, signal);
}

/** Read-only one-call sequential bundle replay on an explicitly supplied provider. No independent transaction fallback. */
export async function collectPumpLaunchGroupTrace(
  input: PumpHolderMessageInput,
  limits: PumpHolderAllowances,
  funding: Funding,
  expiresAt: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const current = () => {
    deadline.throwIfAborted();
    if (
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now() ||
      Date.parse(expiresAt) > Date.now() + 60000
    )
      throw new Error(
        'Bundle source observation expired or has an invalid lifetime.',
      );
  };
  current();
  const p = await plan(input, limits, funding, deadline);
  current();
  const chunks: string[][] = [];
  for (let i = 0; i < p.keys.length; i += 100)
    chunks.push(p.keys.slice(i, i + 100));
  let reads = 0;
  const allowed = new Set([
    'getGenesisHash',
    'simulateBundle',
    'getMultipleAccounts',
    'isBlockhashValid',
    'getBlockHeight',
  ]);
  async function call(method: string, params: unknown[]) {
    current();
    if (!allowed.has(method) || ++reads > 5 + 3 * chunks.length)
      throw new Error('Bundle trace read budget exceeded.');
    const value = await new Promise<unknown>((resolve, reject) => {
      const cancel = () => reject(deadline.reason);
      deadline.addEventListener('abort', cancel, { once: true });
      Promise.resolve()
        .then(() => {
          current();
          return rpc(method, params, deadline);
        })
        .then(
          (v) => {
            deadline.removeEventListener('abort', cancel);
            resolve(v);
          },
          (e) => {
            deadline.removeEventListener('abort', cancel);
            reject(e);
          },
        );
      if (deadline.aborted) cancel();
    });
    current();
    return value;
  }
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Bundle trace requires Solana mainnet.');
  const response = await call('simulateBundle', [
    { encodedTransactions: p.group.packets.map((p) => p.transaction) },
    {
      transactionEncoding: 'base64',
      simulationBank: { slot: p.bank },
      skipSigVerify: true,
      replaceRecentBlockhash: false,
      preExecutionAccountsConfigs: p.tracked.map((addresses) => ({
        encoding: 'base64',
        addresses,
      })),
      postExecutionAccountsConfigs: p.tracked.map((addresses) => ({
        encoding: 'base64',
        addresses,
      })),
    },
  ]);
  const checked = await verify(p, response, deadline);
  current();
  const slots = [p.funding.minimumSlot, p.funding.maximumSlot, p.bank];
  let sourceSlot = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const minimum = Math.max(...slots);
    const parts = await Promise.all(
      chunks.map(async (addresses) => {
        const value = await call('getMultipleAccounts', [
          addresses,
          {
            encoding: 'base64',
            commitment: 'confirmed',
            minContextSlot: minimum,
          },
        ]);
        if (
          !record(value) ||
          !record(value.context) ||
          !Array.isArray(value.value) ||
          value.value.length !== addresses.length
        )
          throw new Error('Bundle source recheck mapping differs.');
        const s = slot(value.context.slot);
        if (s < minimum)
          throw new Error('Bundle source ignored its context slot.');
        return { slot: s, accounts: value.value.map(pumpRpcAccount) };
      }),
    );
    slots.push(...parts.map((p) => p.slot));
    requireConsistentSolanaSlots(slots);
    if (parts.some((part) => part.slot !== parts[0].slot)) {
      if (attempt < 2) continue;
      throw new Error('Bundle source recheck did not share one bank.');
    }
    const values = parts.flatMap((p) => p.accounts);
    for (const [i, key] of p.keys.entries())
      if (
        (await pumpHolderSourceHash(p.source, key, values[i])) !==
        (await pumpHolderSourceHash(p.source, key, checked.before[i]))
      )
        throw new Error('Bundle source changed during simulation.');
    sourceSlot = parts[0].slot;
    break;
  }
  const valid = await call('isBlockhashValid', [
    p.input.create.blockhash,
    { commitment: 'confirmed', minContextSlot: Math.max(...slots) },
  ]);
  if (!record(valid) || !record(valid.context) || valid.value !== true)
    throw new Error('Bundle original blockhash is unavailable.');
  const validSlot = slot(valid.context.slot);
  if (validSlot < Math.max(...slots))
    throw new Error('Bundle validity ignored its context slot.');
  slots.push(validSlot);
  requireConsistentSolanaSlots(slots);
  const height = pumpUnsignedInteger(
    await call('getBlockHeight', [
      { commitment: 'confirmed', minContextSlot: Math.max(...slots) },
    ]),
  );
  if (height + 10n >= p.input.create.lastValidBlockHeight)
    throw new Error(
      'Bundle original lifetime expired or is too close to expiry.',
    );
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Bundle trace provider network changed.');
  current();
  return {
    ...checked,
    rpcCollectionRequired: false as const,
    observedAt: new Date().toISOString(),
    expiresAt,
    sourceRecheckSlot: sourceSlot,
    minimumSlot: Math.min(...slots),
    maximumSlot: Math.max(...slots),
    reads,
  };
}
