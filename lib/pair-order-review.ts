import bs58 from 'bs58';
import {
  pairReviewDiagnostic,
  pairDiagnosticComparisons,
  type PairDiagnosticDetails,
} from './pair-review-diagnostic';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { assessJupiterRoute } from './jupiter-route-assessment';
import {
  inspectPairTokenAccount,
  pairWalletUint,
} from './pair-wallet-evidence';
import type { SolanaSwapRuntimeContext } from './solana-swap-runtime-context';
import type { SolanaPairPreparation } from './warmup-swap-quote';
import type { SwapInstructionReview } from './swap-instruction-review';
import { pairAssociatedAddress } from './pair-wallet-evidence';
import type { PairAuxiliaryAccount } from './pair-order-auxiliary';
import {
  assertPairOrderQuoteBounds,
  type PairQuoteBoundsMode,
} from './pair-order-quote-bounds';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';
const SYSTEM = '11111111111111111111111111111111',
  ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  RENT = 'SysvarRent111111111111111111111111111111111';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  COMPUTE = 'ComputeBudget111111111111111111111111111111';
export type PairOrderAccountSnapshot = { address: string; raw: unknown };
function rawAccount(raw: unknown) {
  const a = raw as {
    owner?: unknown;
    executable?: unknown;
    lamports?: unknown;
    data?: unknown;
  };
  if (
    !a ||
    typeof a.owner !== 'string' ||
    typeof a.executable !== 'boolean' ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length > 21848
  )
    throw Error('Pair candidate account envelope differs.');
  address(a.owner);
  const text = atob(a.data[0]);
  if (btoa(text) !== a.data[0])
    throw Error('Pair candidate account encoding differs.');
  return {
    owner: a.owner,
    executable: a.executable,
    lamports: pairWalletUint(a.lamports),
    bytes: Uint8Array.from(text, (c) => c.charCodeAt(0)),
  };
}
/** Exact top-level setup and raw budget checks. Inner effects still require independent simulation. */
export async function reviewPairOrderInstructions(
  preflight: SolanaSwapRuntimeContext,
  order: SolanaPairPreparation,
  review: SwapInstructionReview,
  snapshots: PairOrderAccountSnapshot[],
  rentByMint: Record<string, string>,
  networkFeeRaw: string,
  auxiliary: PairAuxiliaryAccount[] = [],
  quoteBoundsMode: PairQuoteBoundsMode = 'strict',
) {
  let activeInstruction: (typeof review.instructions)[number] | undefined;
  const fail = (check: string, details: PairDiagnosticDetails = {}): never => {
    throw pairReviewDiagnostic(
      Error(
        'Pair candidate instructions, accounts or raw spending limits differ.',
      ),
      check,
      {
        ...details,
        ...(activeInstruction
          ? {
              instructionProgram: activeInstruction.program.address,
              instructionIndex: activeInstruction.index,
              instructionDataHex: activeInstruction.dataHex,
              instructionAccounts: JSON.stringify(activeInstruction.accounts),
            }
          : {}),
      },
    );
  };
  const original = preflight.quote,
    wallet = preflight.wallet,
    pair = original.pair;
  const input = original.side === 'Buy' ? pair.quote : pair.base,
    output = original.side === 'Buy' ? pair.base : pair.quote;
  assertPairOrderQuoteBounds(original, order, wallet, quoteBoundsMode);
  if (review.unresolvedAccountCount) fail('unresolved-accounts');
  const route = assessJupiterRoute(review, order);
  if (route.status !== 'Matched fields' || !route.decoded) fail('route-decode');
  const decoded = route.decoded!;
  if (
    decoded.v2
      ? decoded.inputTokenProgram !== input.program ||
        decoded.outputTokenProgram !== output.program
      : [input.program, output.program].some((p) => p !== SWAP_TOKEN)
  )
    fail('route-token-program');
  if (new Set(snapshots.map((a) => a.address)).size !== snapshots.length)
    fail('duplicate-snapshots');
  const raw = new Map(snapshots.map((a) => [a.address, a.raw]));
  if (
    auxiliary.length > 8 ||
    new Set(auxiliary.map((a) => a.mint.address)).size !== auxiliary.length ||
    auxiliary.some((a) =>
      [input.address, output.address].includes(a.mint.address),
    ) ||
    [
      input.address,
      output.address,
      ...auxiliary.map((a) => a.mint.address),
    ].some((m) => raw.has(m))
  )
    fail('auxiliary-scope');
  const fee = pairWalletUint(networkFeeRaw);
  if (fee < 1n) fail('network-fee');
  const state = await Promise.all(
    [input, output, ...auxiliary.map((a) => a.mint)].map(async (asset, i) => {
      const selected = preflight.evidence.accounts.find(
        (a) => a.mint === asset.address,
      );
      const extra = i >= 2 ? auxiliary[i - 2] : null;
      if (!selected && !extra) fail('missing-selected-state');
      const target =
        i === 0
          ? decoded.sourceAccount
          : i === 1
            ? decoded.destinationAccount
            : extra!.address;
      if (!raw.has(target)) fail('missing-snapshot');
      const native = asset.address === SWAP_WRAPPED_SOL,
        existing = raw.get(target) !== null;
      if (
        native &&
        (asset.program !== SWAP_TOKEN ||
          asset.decimals !== 9 ||
          asset.amountPolicy.kind !== 'unscaled')
      )
        fail('native-mint-policy');
      if (
        extra &&
        (extra.seededCandidate
          ? !native || existing
          : target !== (await pairAssociatedAddress(extra.mint, wallet)))
      )
        fail('auxiliary-target');
      const rent = pairWalletUint(rentByMint[asset.address]);
      if (rent < 1n) fail('rent-minimum');
      let beforeAmount = 0n;
      if (!native) {
        if (selected && selected.address !== target)
          fail('selected-token-target');
        const observed = await inspectPairTokenAccount(
          raw.get(target),
          {
            ...asset,
            policySha256:
              selected?.mintPolicySha256 ?? extra!.mint.policySha256,
          },
          wallet,
          target,
          preflight.evidence.unixTimestamp,
        );
        if (
          selected &&
          (observed.sourceSha256 !== selected!.sourceSha256 ||
            observed.lamportsRaw !== selected!.lamportsRaw ||
            observed.status !== selected!.status ||
            observed.amountRaw !== selected!.amountRaw)
        )
          fail('selected-token-state', {
            comparisons: pairDiagnosticComparisons(
              {
                sourceSha256: selected!.sourceSha256,
                lamportsRaw: selected!.lamportsRaw,
                status: selected!.status,
                amountRaw: selected!.amountRaw,
              },
              {
                sourceSha256: observed.sourceSha256,
                lamportsRaw: observed.lamportsRaw,
                status: observed.status,
                amountRaw: observed.amountRaw,
              },
            ),
          });
        if (
          extra &&
          existing &&
          (observed.status !== 'Ready' || BigInt(observed.lamportsRaw) < rent)
        )
          fail('auxiliary-existing-state', {
            comparisons: [
              {
                field: 'status',
                before: 'Ready',
                after: observed.status,
              },
              {
                field: 'lamportsRaw',
                before: `>=${rent.toString()}`,
                after: observed.lamportsRaw,
              },
              {
                field: 'byteLength',
                before: observed.expectedByteLength.toString(),
                after: observed.byteLength.toString(),
              },
            ],
          });
        beforeAmount = BigInt(observed.amountRaw);
      } else if (existing) {
        const a = rawAccount(raw.get(target)),
          b = a.bytes,
          v = new DataView(b.buffer);
        if (
          a.owner !== SWAP_TOKEN ||
          a.executable ||
          b.length !== 165 ||
          bs58.encode(b.slice(0, 32)) !== SWAP_WRAPPED_SOL ||
          bs58.encode(b.slice(32, 64)) !== wallet ||
          b[108] !== 1 ||
          v.getUint32(72, true) !== 0 ||
          v.getBigUint64(121, true) !== 0n ||
          v.getUint32(129, true) !== 0 ||
          v.getUint32(109, true) !== 1
        )
          fail('native-existing-state');
        beforeAmount = v.getBigUint64(64, true);
        if (
          a.lamports - beforeAmount !== v.getBigUint64(113, true) ||
          a.lamports - beforeAmount < rent
        )
          fail('native-existing-rent', {
            comparisons: pairDiagnosticComparisons(
              {
                reserveRaw: v.getBigUint64(113, true).toString(),
                rentFloorRaw: rent.toString(),
              },
              {
                reserveRaw: (a.lamports - beforeAmount).toString(),
                rentFloorRaw: (a.lamports - beforeAmount).toString(),
              },
            ),
            nativeBalanceRaw: a.lamports.toString(),
            nativeTokenAmountRaw: beforeAmount.toString(),
          });
      }
      return {
        asset,
        target,
        native,
        existing,
        rent,
        beforeAmount,
        auxiliary: i >= 2,
        mintEvidence: extra?.mint ?? null,
        created: -1,
        initialized: -1,
        funded: -1,
        synced: -1,
        closed: -1,
        seeded: false,
        funding: 0n,
      };
    }),
  );
  if (new Set(state.map((s) => s.target)).size !== state.length)
    fail('overlapping-targets');
  const w = rawAccount(raw.get(wallet));
  if (
    w.owner !== SYSTEM ||
    w.executable ||
    w.bytes.length ||
    w.lamports !== BigInt(preflight.evidence.nativeBalanceRaw)
  )
    fail('system-wallet-state', {
      nativeBalanceChanged:
        w.lamports !== BigInt(preflight.evidence.nativeBalanceRaw),
      systemOwnerChanged: w.owner !== SYSTEM,
      systemExecutable: w.executable,
      systemDataChanged: w.bytes.length !== 0,
      comparisons: pairDiagnosticComparisons(
        {
          nativeBalanceRaw: preflight.evidence.nativeBalanceRaw,
          owner: SYSTEM,
          executable: false,
          dataBytes: 0,
        },
        {
          nativeBalanceRaw: w.lamports.toString(),
          owner: w.owner,
          executable: w.executable,
          dataBytes: w.bytes.length,
        },
      ),
    });
  // Every wallet-controlled token account must belong to the selected pair or
  // the explicitly protected intermediate set. Delegated/close-only custody
  // remains unsupported.
  for (const snapshot of snapshots) {
    if (
      snapshot.raw === null ||
      snapshot.address === wallet ||
      state.some((s) => s.target === snapshot.address)
    )
      continue;
    const a = rawAccount(snapshot.raw);
    if (![SWAP_TOKEN, SWAP_TOKEN_2022].includes(a.owner) || a.executable)
      continue;
    const b = a.bytes,
      v = new DataView(b.buffer);
    if (b.length >= 165 && (b.length === 165 || b[165] === 2)) {
      if (
        bs58.encode(b.slice(32, 64)) === wallet ||
        (v.getUint32(72, true) === 1 &&
          bs58.encode(b.slice(76, 108)) === wallet) ||
        (v.getUint32(129, true) === 1 &&
          bs58.encode(b.slice(133, 165)) === wallet)
      )
        fail('unexpected-wallet-token-custody');
    } else if (
      b.length >= 82 &&
      ((v.getUint32(0, true) === 1 && bs58.encode(b.slice(4, 36)) === wallet) ||
        (v.getUint32(46, true) === 1 &&
          bs58.encode(b.slice(50, 82)) === wallet))
    )
      fail('unexpected-wallet-mint-custody');
  }
  const calls = review.instructions.filter(
    (i) => i.program.address === JUPITER,
  );
  if (calls.length !== 1) fail('route-count');
  const routeIndex = calls[0].index,
    budgetTags = new Set<number>();
  let limit: bigint | null = null,
    price: bigint | null = null,
    setupRent = 0n,
    wrappedInput = 0n;
  for (const instruction of review.instructions) {
    activeInstruction = instruction;
    const p = instruction.program.address,
      a = instruction.accounts;
    if (instruction.program.signer || instruction.program.writable)
      fail('program-privileges');
    const b = Uint8Array.from(instruction.dataHex.match(/../g) ?? [], (x) =>
        parseInt(x, 16),
      ),
      v = new DataView(b.buffer);
    if (p === JUPITER) continue;
    if (p === COMPUTE) {
      if (a.length || budgetTags.has(b[0]) || instruction.index >= routeIndex)
        fail('compute-placement');
      budgetTags.add(b[0]);
      if (b.length === 5 && b[0] === 2) {
        limit = BigInt(v.getUint32(1, true));
        if (limit < 1n || limit > 1400000n) fail('compute-limit');
      } else if (b.length === 9 && b[0] === 3) price = v.getBigUint64(1, true);
      else fail('compute-instruction');
      continue;
    }
    const s = state.find(
      (s) => s.target === a[p === SYSTEM || p === ATA ? 1 : 0]?.address,
    );
    if (!s) fail('setup-target');
    const selected = s!;
    const payer = (i: number) =>
      a[i]?.address === wallet && a[i].signer && a[i].writable;
    const writable = (i: number) => a[i]?.writable && !a[i].signer;
    const readonly = (i: number, key: string) =>
      a[i]?.address === key && !a[i].signer && !a[i].writable;
    if (p === ATA) {
      if (
        instruction.index >= routeIndex ||
        ![6, 7].includes(a.length) ||
        !payer(0) ||
        !writable(1) ||
        a[2]?.address !== wallet ||
        !readonly(3, selected.asset.address) ||
        !readonly(4, SYSTEM) ||
        !readonly(5, selected.asset.program) ||
        (a.length === 7 && !readonly(6, RENT)) ||
        !(b.length === 0 || (b.length === 1 && b[0] <= 1)) ||
        selected.created !== -1
      )
        fail('ata-instruction');
      const [canonical] = await getProgramDerivedAddress({
        programAddress: address(ATA),
        seeds: [
          bs58.decode(wallet),
          bs58.decode(selected.asset.program),
          bs58.decode(selected.asset.address),
        ],
      });
      if (
        canonical !== selected.target ||
        (selected.existing && !(b.length === 1 && b[0] === 1))
      )
        fail('ata-target');
      selected.created = instruction.index;
      selected.initialized = instruction.index;
      if (!selected.existing) setupRent += selected.rent;
    } else if (p === SYSTEM && b.length === 12 && v.getUint32(0, true) === 2) {
      if (
        !selected.native ||
        selected.asset.address !== input.address ||
        instruction.index >= routeIndex ||
        a.length !== 2 ||
        !payer(0) ||
        !writable(1) ||
        selected.funded !== -1 ||
        (!selected.existing && selected.initialized === -1)
      )
        fail('native-transfer');
      selected.funding = v.getBigUint64(4, true);
      selected.funded = instruction.index;
      wrappedInput += selected.funding;
    } else if (p === SYSTEM && b.length >= 92 && v.getUint32(0, true) === 3) {
      const length = v.getBigUint64(36, true),
        offset = 44 + Number(length);
      if (
        length > 32n ||
        b.length !== offset + 48 ||
        instruction.index >= routeIndex ||
        !selected.native ||
        selected.existing ||
        selected.created !== -1 ||
        !payer(0) ||
        !writable(1) ||
        ![2, 3].includes(a.length) ||
        (a.length === 3 && !payer(2)) ||
        bs58.encode(b.slice(4, 36)) !== wallet ||
        v.getBigUint64(offset + 8, true) !== 165n ||
        bs58.encode(b.slice(offset + 16)) !== SWAP_TOKEN
      )
        fail('seeded-create-instruction');
      const target = bs58.encode(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            Uint8Array.from([
              ...bs58.decode(wallet),
              ...b.slice(44, offset),
              ...bs58.decode(SWAP_TOKEN),
            ]).buffer,
          ),
        ),
      );
      const funding = v.getBigUint64(offset, true);
      if (target !== selected.target || funding < selected.rent)
        fail('seeded-target-rent');
      selected.created = instruction.index;
      selected.funded = instruction.index;
      selected.seeded = true;
      selected.funding = funding - selected.rent;
      setupRent += selected.rent;
      wrappedInput += selected.funding;
    } else if (
      p === SWAP_TOKEN &&
      ((b.length === 33 && [16, 18].includes(b[0])) ||
        (b.length === 1 && b[0] === 1))
    ) {
      if (
        !selected.seeded ||
        selected.initialized !== -1 ||
        instruction.index <= selected.created ||
        instruction.index >= routeIndex ||
        a.length !== (b[0] === 18 ? 2 : b[0] === 16 ? 3 : 4) ||
        !writable(0) ||
        !readonly(1, SWAP_WRAPPED_SOL) ||
        (b[0] === 1
          ? a[2]?.address !== wallet || !payer(2) || !readonly(3, RENT)
          : bs58.encode(b.slice(1)) !== wallet ||
            (b[0] === 16 && !readonly(2, RENT)))
      )
        fail('native-initialize');
      selected.initialized = instruction.index;
    } else if (p === SWAP_TOKEN && b.length === 1 && b[0] === 17) {
      if (
        !selected.native ||
        a.length !== 1 ||
        !writable(0) ||
        selected.funded === -1 ||
        selected.synced !== -1 ||
        instruction.index <= selected.funded ||
        instruction.index >= routeIndex ||
        (!selected.existing && selected.initialized === -1)
      )
        fail('native-sync');
      selected.synced = instruction.index;
    } else if (
      p === s!.asset.program &&
      [SWAP_TOKEN, SWAP_TOKEN_2022].includes(p) &&
      b.length === 1 &&
      b[0] === 9
    ) {
      if (
        (!selected.native && !selected.auxiliary) ||
        (selected.auxiliary && selected.beforeAmount !== 0n) ||
        a.length !== 3 ||
        !writable(0) ||
        !payer(1) ||
        a[2]?.address !== wallet ||
        !a[2].signer ||
        instruction.index <= routeIndex ||
        selected.closed !== -1
      )
        fail('token-close');
      selected.closed = instruction.index;
    } else fail('unsupported-setup');
  }
  activeInstruction = undefined;
  for (const s of state) {
    if (!s.existing && (s.created === -1 || s.initialized === -1))
      fail('missing-account-creation');
    if (
      s.auxiliary &&
      auxiliary.find((a) => a.address === s.target)?.seededCandidate &&
      !s.seeded
    )
      fail('missing-seeded-creation');
    if (s.native && s.asset.address === input.address) {
      if (
        s.funding !== BigInt(order.inAmount) ||
        (s.synced === -1 && (!s.seeded || s.funded >= s.initialized))
      )
        fail('native-input-funding');
    } else if (s.funding !== 0n) fail('unexpected-funding');
    if (
      s.native &&
      (s.asset.address === output.address || s.seeded) &&
      s.closed === -1
    )
      fail('missing-native-close');
  }
  if (price !== null && limit === null) fail('compute-price-without-limit');
  const priority = price === null ? 0n : (price * limit! + 999999n) / 1000000n;
  if (
    fee <= priority ||
    fee + setupRent > BigInt(preflight.funding.userFeeAndRentLimitRaw) ||
    wrappedInput +
      fee +
      setupRent +
      BigInt(preflight.evidence.systemRentMinimumRaw) >
      w.lamports
  )
    fail('native-fee-budget');
  return {
    format: 'pair-order-instruction-review-v1' as const,
    route,
    accounts: state.slice(0, 2).map((s) => ({
      mint: s.asset.address,
      program: s.asset.program,
      address: s.target,
      existing: s.existing,
      beforeAmountRaw: s.beforeAmount.toString(),
      created: s.created !== -1,
      seeded: s.seeded,
      closed: s.closed !== -1,
      rentRaw: s.rent.toString(),
    })),
    auxiliaryAccounts: state.slice(2).map((s) => ({
      mint: s.asset.address,
      program: s.asset.program,
      address: s.target,
      existing: s.existing,
      beforeAmountRaw: s.beforeAmount.toString(),
      created: s.created !== -1,
      seeded: s.seeded,
      closed: s.closed !== -1,
      rentRaw: s.rent.toString(),
      mintEvidence: s.mintEvidence!,
      maximumNetDebitRaw: '0' as const,
    })),
    rawInput: order.inAmount,
    minimumOutputRaw: order.minimumOutAmount,
    networkFeeRaw: fee.toString(),
    priorityFeeUpperBoundRaw: priority.toString(),
    computeUnitLimitRaw: (limit ?? 1400000n).toString(),
    accountCreationRentRaw: setupRent.toString(),
    nativeWrappingRaw: wrappedInput.toString(),
    maximumExplicitNativeDebitRaw: (wrappedInput + fee + setupRent).toString(),
    topLevelInstructionsChecked: true as const,
    economicSimulationVerified: false as const,
    applicationReservationsChecked: false as const,
    instructionsVerified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
