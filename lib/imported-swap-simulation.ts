import {
  getBase64Encoder,
  getBase64Decoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { assessSimulatedSwapTokens } from './simulated-swap-balances';
import {
  readSwapLookupAccounts,
  assertSameSwapLookups,
} from './swap-lookup-accounts';
import { reviewSwapInstructions } from './swap-instruction-review';
import { assessJupiterRoute } from './jupiter-route-assessment';
import { readSwapTokenAccountBindings } from './swap-token-account-bindings';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import type { SolanaSwapPreparation } from './warmup-swap-quote';
import {
  SWAP_TOKEN_2022,
  SWAP_TOKEN,
  SWAP_TOKEN_2022_ACCOUNT_SIZE,
  readSwapMintEvidence,
  assertSameSwapMintEvidence,
  type SwapToken2022Evidence,
} from './swap-token-program-evidence';
const integer = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid simulation integer.');
  return BigInt(value);
};
const slot = (value: unknown) => {
  const number = Number(integer(value));
  if (!Number.isSafeInteger(number))
    throw new Error('Invalid simulation context.');
  return number;
};
export class SwapBlockhashExpiredError extends Error {
  constructor() {
    super('Order blockhash expired.');
  }
}
export async function simulateImportedSwap(
  order: SolanaSwapPreparation,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  signingEvidence = false,
) {
  const endpoint = getSolanaIndexerRpcEndpoint();
  const source = new URL(endpoint);
  if (source.protocol !== 'https:' || source.username || source.password)
    throw new Error('Invalid simulation provider.');
  if (
    order.executionAllowed !== false ||
    order.preparation.executionAllowed !== false ||
    order.preparation.instructionsVerified !== false ||
    !Number.isFinite(Date.parse(order.expiresAt)) ||
    Date.parse(order.expiresAt) <= Date.now()
  )
    throw new Error('Invalid simulation order.');
  const bytes = getBase64Encoder().encode(order.preparation.transaction);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(bytes).buffer,
  );
  const fingerprint = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (fingerprint !== order.preparation.sha256)
    throw new Error('Order fingerprint changed.');
  const tx = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(endpoint, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Wrong simulation network.');
  const [height, feeRaw] = await Promise.all([
    rpc('getBlockHeight', [{ commitment: 'confirmed' }]),
    rpc('getFeeForMessage', [
      getBase64Decoder().decode(tx.messageBytes),
      { commitment: 'confirmed' },
    ]),
  ]);
  const blockHeight = integer(height);
  if (blockHeight > integer(order.preparation.lastValidBlockHeight))
    throw new SwapBlockhashExpiredError();
  const fee = feeRaw as { context: { slot: unknown }; value: unknown };
  const feeSlot = slot(fee.context.slot);
  const feeLamports = integer(fee.value).toString();
  const lookupAccounts = await readSwapLookupAccounts(message, feeSlot, rpc);
  const instructionReview = reviewSwapInstructions(
    message,
    lookupAccounts ?? undefined,
  );
  const routeAssessment = assessJupiterRoute(instructionReview, order);
  const beforeBindings = signingEvidence
    ? await readSwapTokenAccountBindings(
        routeAssessment,
        order,
        lookupAccounts?.observedSlot ?? feeSlot,
        rpc,
      )
    : null;
  const routePrograms = routeAssessment.decoded;
  const token2022 =
    signingEvidence &&
    routePrograms?.v2 &&
    [
      routePrograms.inputTokenProgram,
      routePrograms.outputTokenProgram,
    ].includes(SWAP_TOKEN_2022);
  const mintBefore =
    signingEvidence && routePrograms
      ? await readSwapMintEvidence(order, beforeBindings?.slot ?? feeSlot, rpc)
      : null;
  if (
    mintBefore &&
    (mintBefore.mints[0].program !==
      (routePrograms?.v2 ? routePrograms.inputTokenProgram : SWAP_TOKEN) ||
      mintBefore.mints[1].program !==
        (routePrograms?.v2 ? routePrograms.outputTokenProgram : SWAP_TOKEN))
  )
    throw new Error(
      'Route token programs differ from independently observed mints.',
    );
  const token2022Rent = token2022
    ? integer(
        await rpc('getMinimumBalanceForRentExemption', [
          SWAP_TOKEN_2022_ACCOUNT_SIZE,
          { commitment: 'confirmed' },
        ]),
      ).toString()
    : null;
  const rent = signingEvidence
    ? integer(
        await rpc('getMinimumBalanceForRentExemption', [
          165,
          { commitment: 'confirmed' },
        ]),
      ).toString()
    : null;
  const result = (await rpc('simulateTransaction', [
    order.preparation.transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot:
        mintBefore?.slot ??
        beforeBindings?.slot ??
        lookupAccounts?.observedSlot ??
        feeSlot,
      ...(signingEvidence && routeAssessment.decoded
        ? {
            accounts: {
              encoding: 'base64',
              addresses: [
                routeAssessment.decoded.sourceAccount,
                routeAssessment.decoded.destinationAccount,
              ],
            },
          }
        : {}),
      innerInstructions: false,
    },
  ])) as {
    context: { slot: unknown };
    value: {
      err: unknown;
      accounts?: unknown[];
      unitsConsumed?: unknown;
      preBalances?: unknown[];
      postBalances?: unknown[];
      replacementBlockhash?: unknown;
      loadedAddresses?: unknown;
      preTokenBalances?: unknown;
      postTokenBalances?: unknown;
    };
  };
  const simulationSlot = slot(result.context.slot);
  if (
    simulationSlot < feeSlot ||
    (mintBefore !== null && simulationSlot < mintBefore.slot) ||
    (beforeBindings?.slot != null && simulationSlot < beforeBindings.slot) ||
    result.value.replacementBlockhash != null
  )
    throw new Error('Simulation context changed.');
  requireConsistentSolanaSlots([feeSlot, simulationSlot]);
  let lookupRecheckSlot: number | null = null;
  if (lookupAccounts) {
    if (simulationSlot < lookupAccounts.observedSlot)
      throw new Error('Simulation precedes lookup observation.');
    const after = await readSwapLookupAccounts(message, simulationSlot, rpc);
    assertSameSwapLookups(lookupAccounts, after, result.value.loadedAddresses);
    lookupRecheckSlot = after!.observedSlot;
    requireConsistentSolanaSlots([
      feeSlot,
      lookupAccounts.observedSlot,
      simulationSlot,
      lookupRecheckSlot,
    ]);
  }
  if (result.value.err === undefined)
    throw new Error('Missing simulation result.');
  const succeeded = result.value.err === null;
  if (!succeeded) {
    const failure = result.value.err as
      | { InstructionError?: unknown }
      | string
      | null;
    const instruction =
      failure &&
      typeof failure === 'object' &&
      Array.isArray(failure.InstructionError)
        ? failure.InstructionError
        : [];
    const custom = instruction[1];
    console.error('Unsigned swap simulation failed', {
      provider: source.hostname,
      kind:
        typeof failure === 'string' && /^[A-Za-z]{1,64}$/.test(failure)
          ? failure
          : 'Instruction or transaction failure',
      instructionIndex: Number.isSafeInteger(instruction[0])
        ? instruction[0]
        : null,
      customCode:
        custom &&
        typeof custom === 'object' &&
        Number.isSafeInteger(custom.Custom)
          ? custom.Custom
          : null,
    });
  }
  const units =
    result.value.unitsConsumed === undefined
      ? null
      : integer(result.value.unitsConsumed);
  if ((succeeded && units === null) || (units !== null && units > 1400000n))
    throw new Error('Invalid simulation compute usage.');
  let nativeChangeRaw: string | null = null;
  if (succeeded) {
    if (
      !Array.isArray(result.value.preBalances) ||
      !Array.isArray(result.value.postBalances) ||
      result.value.preBalances.length !== order.preparation.accountCount ||
      result.value.postBalances.length !== order.preparation.accountCount
    )
      throw new Error('Missing simulated wallet balances.');
    // The envelope reviewer requires the wallet to be the first, sole signer.
    const before = result.value.preBalances.map(integer),
      after = result.value.postBalances.map(integer);
    nativeChangeRaw = (after[0] - before[0]).toString();
  }
  if (Date.parse(order.expiresAt) <= Date.now())
    throw new Error('Order expired during simulation.');
  const tokens = succeeded
    ? assessSimulatedSwapTokens(
        order,
        message.staticAccounts,
        message.version === 0 ? (message.addressTableLookups ?? []) : [],
        lookupAccounts
          ? {
              ...result.value,
              loadedAddresses: {
                writable: lookupAccounts.writable,
                readonly: lookupAccounts.readonly,
              },
            }
          : result.value,
      )
    : {
        tokensComplete: false,
        tokenChanges: [],
        inputAmountMatches: null,
        minimumOutputCovered: null,
      };
  const accountBindings =
    beforeBindings ??
    (await readSwapTokenAccountBindings(
      routeAssessment,
      order,
      simulationSlot,
      rpc,
    ));
  requireConsistentSolanaSlots([
    feeSlot,
    simulationSlot,
    ...(lookupAccounts
      ? [lookupAccounts.observedSlot, lookupRecheckSlot!]
      : []),
    ...(accountBindings.slot === null ? [] : [accountBindings.slot]),
  ]);
  if (Date.parse(order.expiresAt) <= Date.now())
    throw new Error('Order expired during account observation.');
  let token2022Evidence: SwapToken2022Evidence | undefined;
  if (mintBefore) {
    const mintAfter = await readSwapMintEvidence(
      order,
      lookupRecheckSlot ?? simulationSlot,
      rpc,
    );
    assertSameSwapMintEvidence(mintBefore, mintAfter);
    requireConsistentSolanaSlots([
      feeSlot,
      simulationSlot,
      mintBefore.slot,
      mintAfter.slot,
    ]);
    if (token2022)
      token2022Evidence = {
        format: 'swap-token-2022-evidence-v1',
        ...mintBefore,
        recheckSlot: mintAfter.slot,
        accountSize: SWAP_TOKEN_2022_ACCOUNT_SIZE,
        rentLamports: token2022Rent!,
      };
    if (Date.parse(order.expiresAt) <= Date.now())
      throw new Error('Order expired during mint recheck.');
  }
  return {
    executionAllowed: false as const,
    instructionsVerified: false as const,
    sha256: fingerprint,
    wallet: order.preparation.wallet,
    succeeded,
    ...(!succeeded && result.value.err === 'BlockhashNotFound'
      ? { failureReason: 'BlockhashNotFound' as const }
      : {}),
    network: 'Solana mainnet' as const,
    source: source.hostname,
    observedAt: new Date().toISOString(),
    feeSlot,
    simulationSlot,
    blockHeight: blockHeight.toString(),
    networkFeeLamports: feeLamports,
    unitsConsumed: units?.toString() ?? null,
    nativeChangeRaw,
    instructionReview,
    routeAssessment,
    accountBindings,
    ...(token2022Evidence ? { token2022Evidence } : {}),
    settlementEvidence: signingEvidence
      ? {
          keys: [
            ...message.staticAccounts,
            ...(lookupAccounts?.writable ?? []),
            ...(lookupAccounts?.readonly ?? []),
          ].map(String),
          before:
            result.value.preBalances?.map((v) => integer(v).toString()) ?? [],
          after:
            result.value.postBalances?.map((v) => integer(v).toString()) ?? [],
          preTokens: result.value.preTokenBalances,
          postTokens: result.value.postTokenBalances,
          postAccounts: result.value.accounts,
          rentLamports: rent!,
        }
      : null,
    lookupObservation: lookupAccounts
      ? {
          slot: lookupAccounts.observedSlot,
          recheckSlot: lookupRecheckSlot!,
          tables: lookupAccounts.tables.map(
            ({ address, sha256, lastExtendedSlot }) => ({
              address,
              sha256,
              lastExtendedSlot,
            }),
          ),
        }
      : null,
    ...tokens,
    limitations:
      'Unsigned simulation only. Native and wallet-attributed token changes are provider observations, not final receipts. Token comparisons require complete ownership metadata. Wrapped SOL comparisons are withheld because wrapping, rent and account closure affect net balances. Account authority changes, program semantics and debit limits remain unverified. No signing or execution clearance.',
  };
}
export type ImportedSwapSimulation = Awaited<
  ReturnType<typeof simulateImportedSwap>
>;
