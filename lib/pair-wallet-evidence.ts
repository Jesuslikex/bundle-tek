import { readPairPartitionObservation } from './pair-partition-observation';
import { stockPairRpcScope } from './pair-stock-clock';
import { collectPairAccountPartitions } from './pair-account-partitions';
import { pairEvidenceClock } from './pair-stock-clock';
import bs58 from 'bs58';
import {
  pairReviewDiagnostic,
  pairDiagnosticComparisons,
} from './pair-review-diagnostic';
import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  getExtensionDecoder,
  getExtensionEncoder,
  getTokenSize,
  type ExtensionArgs,
} from '@solana-program/token-2022';
import {
  PAIR_CLOCK,
  PairMintPolicyError,
  inspectPairMintAccount,
  assertSamePairMintEvidence,
  type PairMintEvidence,
  type PairMintMetadata,
} from './pair-mint-evidence';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';
import { pairUiAmount, activePairMultiplier } from './pair-ui-amount';
import type { ImportedPairQuote } from './imported-trade-pair';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';
const SYSTEM = '11111111111111111111111111111111';
const MAX = (1n << 64n) - 1n;
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export type PairWalletAccount = {
  mint: string;
  program: string;
  address: string | null;
  kind: 'native-sol' | 'associated-token';
  status:
    | 'Ready'
    | 'Missing'
    | 'Frozen'
    | 'Restricted'
    | 'Needs extension setup';
  amountRaw: string;
  spendableRaw: string;
  amount: string;
  byteLength: number;
  expectedByteLength: number;
  extensions: string[];
  requiredExtensions: string[];
  missingExtensions: string[];
  rentMinimumRaw: string;
  lamportsRaw: string;
  sourceSha256: string | null;
  mintPolicySha256: string;
};
export type PairWalletEvidence = {
  clock?: import('./pair-stock-clock').PairClockObservation;
  format: 'pair-wallet-evidence-v1';
  scope: 'canonical-associated-accounts';
  wallet: string;
  slot: number;
  unixTimestamp: string;
  nativeBalanceRaw: string;
  walletExists: boolean;
  systemRentMinimumRaw: string;
  accounts: PairWalletAccount[];
  signingAllowed: false;
  executionAllowed: false;
};
export function pairWalletUint(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > MAX
  )
    throw new Error('Pair wallet units are invalid.');
  return BigInt(value);
}
export function requiredPairAccountExtensions(
  mint: PairMintMetadata,
): ExtensionArgs[] {
  if (mint.program === SWAP_TOKEN) return [];
  if (mint.program !== SWAP_TOKEN_2022) throw new PairMintPolicyError();
  return [
    { __kind: 'ImmutableOwner' },
    ...(mint.extensions.includes('PausableConfig')
      ? [{ __kind: 'PausableAccount' as const }]
      : []),
    ...(mint.extensions.includes('TransferHook')
      ? [{ __kind: 'TransferHookAccount' as const, transferring: false }]
      : []),
  ];
}
export async function pairAssociatedAddress(
  mint: PairMintMetadata,
  wallet: string,
) {
  return String(
    (
      await findAssociatedTokenPda({
        owner: address(wallet),
        mint: address(mint.address),
        tokenProgram: address(mint.program),
      })
    )[0],
  );
}
function bytes(raw: unknown, owner: string, minimum: number) {
  const a = raw as {
    owner?: unknown;
    executable?: unknown;
    lamports?: unknown;
    data?: unknown;
  };
  if (
    !a ||
    a.owner !== owner ||
    a.executable !== false ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length > 5464
  )
    throw new Error('Pair wallet account envelope differs.');
  const text = atob(a.data[0]);
  if (btoa(text) !== a.data[0] || text.length < minimum || text.length > 4096)
    throw new Error('Pair wallet account encoding differs.');
  return {
    data: Uint8Array.from(text, (c) => c.charCodeAt(0)),
    lamports: pairWalletUint(a.lamports).toString(),
  };
}
export async function inspectPairTokenAccount(
  raw: unknown,
  mint: PairMintMetadata,
  wallet: string,
  ata: string,
  unix: string,
): Promise<PairWalletAccount> {
  const required = requiredPairAccountExtensions(mint);
  const expectedByteLength =
    mint.program === SWAP_TOKEN ? 165 : getTokenSize(required);
  const base: PairWalletAccount = {
    mint: mint.address,
    program: mint.program,
    address: ata,
    kind: 'associated-token',
    status: 'Missing',
    amountRaw: '0',
    spendableRaw: '0',
    amount: '0',
    byteLength: 0,
    expectedByteLength,
    extensions: [],
    requiredExtensions: required.map((e) => e.__kind).sort(),
    missingExtensions: required.map((e) => e.__kind).sort(),
    rentMinimumRaw: '0',
    lamportsRaw: '0',
    sourceSha256: null,
    mintPolicySha256: mint.policySha256,
  };
  if (raw === null) return base;
  const { data, lamports } = bytes(raw, mint.program, 165),
    view = new DataView(data.buffer);
  if (
    bs58.encode(data.slice(0, 32)) !== mint.address ||
    bs58.encode(data.slice(32, 64)) !== wallet
  )
    throw new PairMintPolicyError(
      'Selected token account mint or wallet differs.',
    );
  const option = (offset: number) => {
    const tag = view.getUint32(offset, true);
    if (tag > 1)
      throw new PairMintPolicyError(
        'Selected token account authority is malformed.',
      );
    return tag === 1;
  };
  const delegated = option(72),
    native = option(109),
    closeAuthority = option(129);
  if (
    data[108] > 2 ||
    native ||
    (!delegated && view.getBigUint64(121, true) !== 0n)
  )
    throw new PairMintPolicyError(
      'Selected token account state is unsupported.',
    );
  const names: string[] = [];
  if (data.length !== 165) {
    if (
      mint.program !== SWAP_TOKEN_2022 ||
      data.length < 166 ||
      data[165] !== 2
    )
      throw new PairMintPolicyError(
        'Selected token account extension layout differs.',
      );
    for (let offset = 166; offset < data.length;) {
      if (data.slice(offset).every((v) => v === 0)) break;
      if (offset + 4 > data.length) throw new PairMintPolicyError();
      const end = offset + 4 + view.getUint16(offset + 2, true);
      if (end > data.length) throw new PairMintPolicyError();
      try {
        const encoded = data.slice(offset, end),
          e = getExtensionDecoder().decode(encoded),
          canonical = getExtensionEncoder().encode(e);
        if (
          ![
            'ImmutableOwner',
            'PausableAccount',
            'TransferHookAccount',
          ].includes(e.__kind) ||
          names.includes(e.__kind) ||
          (e.__kind === 'TransferHookAccount' && e.transferring) ||
          canonical.length !== encoded.length ||
          canonical.some((v, i) => v !== encoded[i])
        )
          throw new PairMintPolicyError();
        if (
          (e.__kind === 'PausableAccount' &&
            !mint.extensions.includes('PausableConfig')) ||
          (e.__kind === 'TransferHookAccount' &&
            !mint.extensions.includes('TransferHook'))
        )
          throw new PairMintPolicyError();
        names.push(e.__kind);
      } catch {
        throw new PairMintPolicyError(
          'Selected token account requires a separate extension adapter.',
        );
      }
      offset = end;
    }
  }
  const missing = base.requiredExtensions.filter((e) => !names.includes(e));
  const status: PairWalletAccount['status'] =
    data[108] === 2
      ? 'Frozen'
      : data[108] !== 1 || delegated || closeAuthority
        ? 'Restricted'
        : missing.length
          ? 'Needs extension setup'
          : 'Ready';
  const amountRaw = view.getBigUint64(64, true).toString();
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', data.buffer),
  );
  return {
    ...base,
    status,
    amountRaw,
    spendableRaw: status === 'Ready' ? amountRaw : '0',
    amount: pairUiAmount(amountRaw, mint.decimals, mint.amountPolicy, unix),
    byteLength: data.length,
    extensions: names.sort(),
    missingExtensions: missing,
    lamportsRaw: lamports,
    sourceSha256: Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join(
      '',
    ),
  };
}
/** Selected accounts only; this does not claim total wallet inventory or grant signing. */
export async function readPairWalletEvidence(
  mints: PairMintEvidence,
  wallet: string,
  rpc: Rpc,
  now = Date.now(),
): Promise<PairWalletEvidence> {
  const scope = stockPairRpcScope(rpc);
  if (scope?.accountLimit === 5) {
    if (!scope.signal) throw Error('Stock lifecycle signal is missing.');
    return collectPairWalletEvidence(
      mints,
      wallet,
      now,
      async (requested, floor) => {
        const observed = await readPairPartitionObservation(
          requested,
          floor,
          rpc,
          scope.signal!,
          scope.now,
        );
        return { response: observed.clockResponse, values: observed.values };
      },
    );
  }
  return collectPairWalletEvidence(
    mints,
    wallet,
    now,
    async (requested, floor) => {
      const response = (await rpc('getMultipleAccounts', [
        requested,
        { encoding: 'base64', commitment: 'confirmed', minContextSlot: floor },
      ])) as { context?: { slot?: unknown }; value?: unknown[] };
      return { response, values: response?.value };
    },
  );
}
/** Explicit partition composition using the same wallet parser and custody checks. */
export async function readPartitionedPairWalletEvidence(
  mints: PairMintEvidence,
  wallet: string,
  rpc: Rpc,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  let partitions:
    | Awaited<ReturnType<typeof collectPairAccountPartitions>>
    | undefined;
  const evidence = await collectPairWalletEvidence(
    mints,
    wallet,
    now(),
    async (requested, floor) => {
      const observed = await readPairPartitionObservation(
        requested,
        floor,
        rpc,
        signal,
        now,
      );
      partitions = observed.partitions;
      return { response: observed.clockResponse, values: observed.values };
    },
  );
  signal.throwIfAborted();
  if (!partitions) throw Error('Partitioned wallet evidence is missing.');
  for (const partition of partitions.partitions)
    pairEvidenceClock(
      partition.response,
      partition.response.value.at(-1),
      Number(partition.response.context.slot),
      now(),
    );
  return { evidence, partitions };
}
async function collectPairWalletEvidence(
  mints: PairMintEvidence,
  wallet: string,
  now: number,
  readAccounts: (
    requested: string[],
    floor: number,
  ) => Promise<{
    response: { context?: { slot?: unknown }; value?: unknown[] };
    values: unknown;
  }>,
): Promise<PairWalletEvidence> {
  address(wallet);
  if (
    !Number.isSafeInteger(mints.slot) ||
    mints.slot < 1 ||
    mints.mints.length !== 2 ||
    mints.mints[0].address === mints.mints[1].address ||
    mints.mints.some(
      (m) =>
        m.address === SWAP_WRAPPED_SOL &&
        (m.program !== SWAP_TOKEN ||
          m.decimals !== 9 ||
          m.amountPolicy.kind !== 'unscaled'),
    )
  )
    throw new Error('Pair wallet mint scope differs.');
  const atas = await Promise.all(
    mints.mints.map(async (m) =>
      m.address === SWAP_WRAPPED_SOL ? null : pairAssociatedAddress(m, wallet),
    ),
  );
  const requested = [
    wallet,
    ...atas.filter((a): a is string => a !== null),
    ...mints.mints.map((m) => m.address),
    PAIR_RENT,
    PAIR_CLOCK,
  ];
  if (new Set(requested).size !== requested.length)
    throw new Error('Pair wallet account scope overlaps.');
  const { response: result, values } = await readAccounts(
    requested,
    mints.slot,
  );
  const s = result?.context?.slot;
  if (
    typeof s !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(s) ||
    !Number.isSafeInteger(Number(s)) ||
    Number(s) < mints.slot ||
    Number(s) > mints.slot + 32 ||
    !Array.isArray(values) ||
    values.length !== requested.length
  )
    throw new Error('Pair wallet account context differs.');
  const clock = pairEvidenceClock(result, result.value?.at(-1), Number(s), now);
  const unix = clock.unixTimestamp;
  const rent = inspectPairRentAccount(values[requested.indexOf(PAIR_RENT)]);
  const observedMints: PairMintEvidence = {
    slot: clock.slot,
    clock,
    unixTimestamp: unix,
    mints: await Promise.all(
      mints.mints.map((m) =>
        inspectPairMintAccount(
          values![requested.indexOf(m.address)],
          m.address,
        ),
      ),
    ),
  };
  assertSamePairMintEvidence(mints, observedMints);
  if (
    BigInt(unix) < BigInt(mints.unixTimestamp) ||
    BigInt(unix) > BigInt(mints.unixTimestamp) + 30n ||
    mints.mints.some(
      (m) =>
        activePairMultiplier(m.amountPolicy, mints.unixTimestamp) !==
        activePairMultiplier(m.amountPolicy, unix),
    )
  )
    throw new PairMintPolicyError(
      'Pair wallet policy clock changed. Request a new quote.',
    );
  const walletExists = values[0] !== null;
  const system = walletExists
    ? bytes(values[0], SYSTEM, 0)
    : { data: new Uint8Array(), lamports: '0' };
  if (system.data.length !== 0)
    throw new PairMintPolicyError(
      'Selected wallet must be an ordinary system account.',
    );
  const accounts = await Promise.all(
    mints.mints.map(
      (m, i): Promise<PairWalletAccount> =>
        atas[i] === null
          ? Promise.resolve({
              mint: m.address,
              program: m.program,
              address: null,
              kind: 'native-sol',
              status: walletExists ? 'Ready' : 'Missing',
              amountRaw: system.lamports,
              spendableRaw: system.lamports,
              amount: pairUiAmount(
                system.lamports,
                m.decimals,
                m.amountPolicy,
                unix,
              ),
              byteLength: 0,
              expectedByteLength: 0,
              extensions: [],
              requiredExtensions: [],
              missingExtensions: [],
              rentMinimumRaw: '0',
              lamportsRaw: system.lamports,
              sourceSha256: null,
              mintPolicySha256: m.policySha256,
            })
          : inspectPairTokenAccount(
              values![requested.indexOf(atas[i]!)],
              m,
              wallet,
              atas[i]!,
              unix,
            ),
    ),
  );
  const sizes = [
    ...new Set([
      0,
      ...accounts
        .filter((a) => a.kind === 'associated-token')
        .map((a) => a.byteLength || a.expectedByteLength),
    ]),
  ];
  const rents = new Map(
    sizes.map((size) => [size, pairRentMinimumRaw(rent, size)]),
  );
  for (const a of accounts) {
    a.rentMinimumRaw = rents.get(
      a.kind === 'native-sol' ? 0 : a.byteLength || a.expectedByteLength,
    )!;
    if (
      a.status === 'Ready' &&
      a.kind === 'associated-token' &&
      BigInt(a.lamportsRaw) < BigInt(a.rentMinimumRaw)
    ) {
      a.status = 'Restricted';
      a.spendableRaw = '0';
    }
  }
  return {
    format: 'pair-wallet-evidence-v1',
    scope: 'canonical-associated-accounts',
    wallet,
    slot: clock.slot,
    clock,
    unixTimestamp: unix,
    nativeBalanceRaw: system.lamports,
    walletExists,
    systemRentMinimumRaw: rents.get(0)!,
    accounts,
    signingAllowed: false,
    executionAllowed: false,
  };
}
export function assessPairWalletFunding(
  quote: ImportedPairQuote,
  evidence: PairWalletEvidence,
  feeAndRentLimitRaw: string,
) {
  const reserve = pairWalletUint(feeAndRentLimitRaw);
  if (
    reserve < 1n ||
    evidence.accounts.length !== 2 ||
    evidence.accounts[0].mint !== quote.pair.base.address ||
    evidence.accounts[1].mint !== quote.pair.quote.address ||
    evidence.accounts[0].mintPolicySha256 !==
      quote.pair.mintPolicy.baseSha256 ||
    evidence.accounts[1].mintPolicySha256 !== quote.pair.mintPolicy.quoteSha256
  )
    throw new Error('Pair wallet funding scope differs.');
  const input = evidence.accounts[quote.side === 'Buy' ? 1 : 0],
    output = evidence.accounts[quote.side === 'Buy' ? 0 : 1];
  const nativeInput = input.kind === 'native-sol' ? BigInt(quote.inputRaw) : 0n;
  const destinationRent =
    output.kind === 'associated-token' && output.status === 'Missing'
      ? BigInt(output.rentMinimumRaw)
      : 0n;
  const requiredNative =
    nativeInput + reserve + BigInt(evidence.systemRentMinimumRaw);
  const inputBalanceSufficient =
    input.status === 'Ready' &&
    BigInt(input.spendableRaw) >= BigInt(quote.inputRaw);
  const outputAccountUsable =
    output.kind === 'native-sol' ||
    output.status === 'Ready' ||
    output.status === 'Missing';
  const creationRentWithinAllowance = destinationRent <= reserve;
  const nativeReserveSufficient =
    evidence.walletExists &&
    BigInt(evidence.nativeBalanceRaw) >= requiredNative;
  return {
    inputMint: input.mint,
    inputAccount: input.address,
    outputMint: output.mint,
    outputAccount: output.address,
    inputRaw: quote.inputRaw,
    availableInputRaw: input.spendableRaw,
    inputBalanceSufficient,
    outputAccountUsable,
    createDestinationAccount:
      output.kind === 'associated-token' && output.status === 'Missing',
    destinationAccountRentRaw: destinationRent.toString(),
    userFeeAndRentLimitRaw: reserve.toString(),
    requiredNativeBalanceRaw: requiredNative.toString(),
    creationRentWithinAllowance,
    nativeReserveSufficient,
    canRequestUnsignedOrder:
      inputBalanceSufficient &&
      outputAccountUsable &&
      creationRentWithinAllowance &&
      nativeReserveSufficient,
    feesEstimated: false as const,
    routeAccountRentVerified: false as const,
    walletOwnershipVerified: false as const,
    applicationReservationsChecked: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
export function assertStablePairWalletEvidence(
  before: PairWalletEvidence,
  after: PairWalletEvidence,
) {
  const identity = (e: PairWalletEvidence) => [
    e.wallet,
    e.scope,
    e.walletExists,
    e.nativeBalanceRaw,
    e.systemRentMinimumRaw,
    e.accounts,
  ];
  if (
    after.slot < before.slot ||
    after.slot > before.slot + 32 ||
    BigInt(after.unixTimestamp) < BigInt(before.unixTimestamp) ||
    BigInt(after.unixTimestamp) > BigInt(before.unixTimestamp) + 30n ||
    JSON.stringify(identity(before)) !== JSON.stringify(identity(after))
  )
    throw pairReviewDiagnostic(
      new PairMintPolicyError(
        'Selected wallet balances, custody or rent changed. Request a new preflight.',
      ),
      'wallet-stability',
      {
        slotDelta: after.slot - before.slot,
        unixDelta: Number(
          BigInt(after.unixTimestamp) - BigInt(before.unixTimestamp),
        ),
        nativeBalanceChanged:
          before.nativeBalanceRaw !== after.nativeBalanceRaw,
        changedAccountFields: [
          ...new Set(
            before.accounts.flatMap((a, i) =>
              (Object.keys(a) as (keyof PairWalletAccount)[]).filter(
                (key) =>
                  JSON.stringify(a[key]) !==
                  JSON.stringify(after.accounts[i]?.[key]),
              ),
            ),
          ),
        ],
        comparisons: pairDiagnosticComparisons(
          {
            slot: before.slot,
            wallet: before.wallet,
            scope: before.scope,
            unixTimestamp: before.unixTimestamp,
            nativeBalanceRaw: before.nativeBalanceRaw,
            walletExists: before.walletExists,
            systemRentMinimumRaw: before.systemRentMinimumRaw,
            ...Object.fromEntries(
              before.accounts.flatMap((a, i) =>
                Object.entries(a).map(([k, v]) => [`accounts[${i}].${k}`, v]),
              ),
            ),
          },
          {
            slot: after.slot,
            wallet: after.wallet,
            scope: after.scope,
            unixTimestamp: after.unixTimestamp,
            nativeBalanceRaw: after.nativeBalanceRaw,
            walletExists: after.walletExists,
            systemRentMinimumRaw: after.systemRentMinimumRaw,
            ...Object.fromEntries(
              after.accounts.flatMap((a, i) =>
                Object.entries(a).map(([k, v]) => [`accounts[${i}].${k}`, v]),
              ),
            ),
          },
        ),
      },
    );
}
