import {
  pumpAccountBytes,
  pumpRpcAccount,
  pumpSystemAccount,
  pumpUnsignedInteger,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from './pump-holder-review';
import {
  buildPumpGroupTip,
  broadcastBudgets,
  type PumpGroupBroadcastReview,
} from './pump-group-broadcast';
import { refreshPumpLaunchGroupReview } from './pump-launch-group-review-service';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
const rec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const bank = (v: unknown) => {
  const n = Number(
    pumpUnsignedInteger(
      typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
        ? v.toString()
        : v,
    ),
  );
  if (!Number.isSafeInteger(n)) throw new Error('Broadcast bank differs.');
  return n;
};
const snapshot = (v: unknown) => {
  if (!rec(v)) throw new Error('Broadcast simulation frame differs.');
  return {
    err: v.err,
    replacementBlockhash: v.replacementBlockhash ?? null,
    preExecutionAccounts: v.preExecutionAccounts,
    postExecutionAccounts: v.postExecutionAccounts,
    loadedAddresses: v.loadedAddresses ?? null,
    fee: v.fee,
    unitsConsumed: v.unitsConsumed,
    loadedAccountsDataSize: v.loadedAccountsDataSize,
  };
};
/** Replays the original independently accounted prefix and the extra tip together. Never substitutes independent packet simulations. */
export async function simulateOwnedPumpGroupBroadcast(
  db: D1Database,
  owner: string,
  r: PumpGroupBroadcastReview,
  tip: string | null,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  let request: unknown[] | undefined, original: unknown;
  const fresh = await refreshPumpLaunchGroupReview(
    db,
    owner,
    r.reviewId,
    deadline,
    async (method, params, control) => {
      const result = await rpc(method, params, control);
      if (method === 'simulateBundle') {
        if (request) throw new Error('Unexpected repeated group replay.');
        request = structuredClone(params);
        original = structuredClone(result);
      }
      return result;
    },
    'signed-broadcast',
  );
  deadline.throwIfAborted();
  if (
    !request ||
    !rec(request[1]) ||
    !rec(original) ||
    !rec(original.context) ||
    !rec(original.value) ||
    !Array.isArray(original.value.transactionResults)
  )
    throw new Error('Original complete replay unavailable.');
  const config = request[1],
    slot = bank(original.context.slot);
  if (
    !rec(config.simulationBank) ||
    bank(config.simulationBank.slot) !== slot ||
    config.skipSigVerify !== true ||
    config.replaceRecentBlockhash !== false ||
    !Array.isArray(config.preExecutionAccountsConfigs) ||
    !Array.isArray(config.postExecutionAccountsConfigs)
  )
    throw new Error('Original replay bank or profile differs.');
  const pre = config.preExecutionAccountsConfigs as {
      addresses: string[];
      encoding: string;
    }[],
    post = config.postExecutionAccountsConfigs as {
      addresses: string[];
      encoding: string;
    }[];
  if (
    pre.length !== r.transactions.length ||
    post.length !== r.transactions.length ||
    original.value.transactionResults.length !== r.transactions.length ||
    pre.some(
      (p) => !Array.isArray(p.addresses) || p.addresses.includes(r.recipient),
    )
  )
    throw new Error(
      'Tip recipient overlaps the launch or packet coverage differs.',
    );
  const budget = broadcastBudgets(r.tipRaw, r.tipFeeLimitRaw);
  const payer = fresh.checked.funding.wallets.find(
    (w) => w.address === r.payer,
  );
  if (
    !payer ||
    payer.observedSolRaw === null ||
    BigInt(payer.observedSolRaw) <
      BigInt(payer.requiredSolRaw) + budget.tip + budget.fee
  )
    throw new Error(
      'Payer needs the full launch caps plus the separate tip and tip fee cap.',
    );
  const built = buildPumpGroupTip(r);
  const feeResponse = (await rpc(
    'getFeeForMessage',
    [
      Buffer.from(built.message).toString('base64'),
      { commitment: 'confirmed', minContextSlot: slot },
    ],
    deadline,
  )) as { context: { slot: unknown }; value: unknown };
  const feeSlot = bank(feeResponse?.context?.slot),
    fee = pumpUnsignedInteger(feeResponse?.value);
  if (feeSlot < slot || feeSlot - slot > 32 || fee < 1n || fee > budget.fee)
    throw new Error('Tip fee or bank exceeds the reviewed cap.');
  const result = await rpc(
    'simulateBundle',
    [
      { encodedTransactions: [...r.transactions, tip ?? r.tipTransaction] },
      {
        ...config,
        skipSigVerify: tip !== null ? false : true,
        preExecutionAccountsConfigs: [
          ...pre,
          { encoding: 'base64', addresses: [r.payer, r.recipient] },
        ],
        postExecutionAccountsConfigs: [
          ...post,
          { encoding: 'base64', addresses: [r.payer, r.recipient] },
        ],
      },
    ],
    deadline,
  );
  if (
    !rec(result) ||
    !rec(result.context) ||
    bank(result.context.slot) !== slot ||
    !rec(result.value) ||
    result.value.summary !== 'succeeded' ||
    !Array.isArray(result.value.transactionResults) ||
    result.value.transactionResults.length !== r.transactions.length + 1
  )
    throw new Error('Complete group and tip replay failed or changed banks.');
  const frames = result.value.transactionResults;
  for (let i = 0; i < r.transactions.length; i++)
    if (
      canonicalPumpHolderJson(snapshot(frames[i])) !==
      canonicalPumpHolderJson(snapshot(original.value.transactionResults[i]))
    )
      throw new Error(
        'Adding the tip changed independently verified launch effects.',
      );
  const last = frames.at(-1);
  if (
    !rec(last) ||
    last.err !== null ||
    last.replacementBlockhash != null ||
    !Array.isArray(last.preExecutionAccounts) ||
    last.preExecutionAccounts.length !== 2 ||
    !Array.isArray(last.postExecutionAccounts) ||
    last.postExecutionAccounts.length !== 2 ||
    pumpUnsignedInteger(last.fee) !== fee ||
    pumpUnsignedInteger(last.unitsConsumed) < 1n ||
    pumpUnsignedInteger(last.unitsConsumed) > 20000n ||
    pumpUnsignedInteger(last.loadedAccountsDataSize) > 67108864n ||
    (last.loadedAddresses != null &&
      (!rec(last.loadedAddresses) ||
        !Array.isArray(last.loadedAddresses.writable) ||
        last.loadedAddresses.writable.length ||
        !Array.isArray(last.loadedAddresses.readonly) ||
        last.loadedAddresses.readonly.length))
  )
    throw new Error('Tip simulation metadata differs.');
  const before = last.preExecutionAccounts.map(pumpRpcAccount),
    after = last.postExecutionAccounts.map(pumpRpcAccount);
  if (
    !before.every(pumpSystemAccount) ||
    !after.every(pumpSystemAccount) ||
    before.some((a) => !a) ||
    after.some((a) => !a)
  )
    throw new Error('Tip accounts must be plain existing System accounts.');
  const priorFrame = frames[r.transactions.length - 1] as {
    postExecutionAccounts: unknown[];
  };
  const index = post.at(-1)!.addresses.indexOf(r.payer);
  if (
    index < 0 ||
    canonicalPumpHolderJson(
      pumpRpcAccount(priorFrame.postExecutionAccounts[index]),
    ) !== canonicalPumpHolderJson(before[0])
  )
    throw new Error('Tip does not continue the complete launch bank.');
  for (const [i, a] of before.entries())
    if (
      a!.owner !== after[i]!.owner ||
      a!.executable !== after[i]!.executable ||
      !Buffer.from(pumpAccountBytes(a!)).equals(
        Buffer.from(pumpAccountBytes(after[i]!)),
      )
    )
      throw new Error('Tip changed account custody.');
  if (
    BigInt(before[0]!.lamports) - BigInt(after[0]!.lamports) !==
      budget.tip + fee ||
    BigInt(after[1]!.lamports) - BigInt(before[1]!.lamports) !== budget.tip
  )
    throw new Error('Tip debit, fee or recipient credit differs.');
  if ((await rpc('getGenesisHash', [], deadline)) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Broadcast provider network changed.');
  const height = pumpUnsignedInteger(
    await rpc(
      'getBlockHeight',
      [{ commitment: 'confirmed', minContextSlot: Math.max(slot, feeSlot) }],
      deadline,
    ),
  );
  if (
    height + 10n >= BigInt(r.lastValidBlockHeight) ||
    Date.parse(r.expiresAt) <= Date.now()
  )
    throw new Error('Original group lifetime is too close to expiry.');
  deadline.throwIfAborted();
  return {
    format: 'pump-group-jito-simulation-v1' as const,
    bankSlot: slot,
    tipFeeRaw: fee.toString(),
    launchSimulationSha256: fresh.simulationSha256,
    replaySha256: await pumpHolderDigest(result),
    expiresAt: r.expiresAt,
    executionAllowed: false as const,
  };
}
