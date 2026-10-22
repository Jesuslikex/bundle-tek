import bs58 from 'bs58';
import { address, getProgramDerivedAddress } from '@solana/kit';
import type { ImportedSwapSimulation } from './imported-swap-simulation';
import type { SolanaSwapPreparation } from './warmup-swap-quote';
import {
  assessJupiterExactOutRoute,
  type JupiterExactOutOrder,
} from './jupiter-exact-out-assessment';
import {
  swapTokenBytes,
  swapToken2022Programs,
  SWAP_TOKEN_2022,
  type SwapToken2022Evidence,
} from './swap-token-program-evidence';
export const WARMUP_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const WARMUP_NATIVE = 'So11111111111111111111111111111111111111112';
const SYSTEM = '11111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const RENT = 'SysvarRent111111111111111111111111111111111';
const uint = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    throw new Error('Signing requires complete account integers.');
  return BigInt(v);
};
type Token = {
  mint: string;
  amount: bigint;
  decimals: number;
  program: string;
};
// Preserve each account identity instead of relying on a mint-level net balance.
export function warmupAccountTokens(
  keys: readonly string[],
  wallet: string,
  raw: unknown,
  programs?: ReadonlyMap<string, string>,
) {
  if (!Array.isArray(raw) || raw.length > 256)
    throw new Error('Signing requires complete account token metadata.');
  const values = new Map<number, Token>();
  const seen = new Set<number>();
  for (const entry of raw) {
    const index = Number(uint(entry?.accountIndex));
    if (index >= keys.length || seen.has(index))
      throw new Error('Signing requires unique token account indexes.');
    seen.add(index);
    if (typeof entry.owner !== 'string' || typeof entry.programId !== 'string')
      throw new Error('Signing requires token ownership metadata.');
    if (entry.owner !== wallet) continue;
    if (
      entry.programId !== (programs?.get(entry.mint) ?? WARMUP_TOKEN) ||
      bs58.decode(entry.mint).length !== 32
    )
      throw new Error('Signing requires standard SPL tokens.');
    const decimals = Number(uint(entry.uiTokenAmount?.decimals));
    if (decimals > 18 || (entry.mint === WARMUP_NATIVE && decimals !== 9))
      throw new Error('Signing requires supported token precision.');
    values.set(index, {
      mint: entry.mint,
      amount: uint(entry.uiTokenAmount?.amount),
      decimals,
      program: entry.programId,
    });
  }
  return values;
}
export function warmupRentChange(
  keys: readonly string[],
  wallet: string,
  before: readonly string[],
  after: readonly string[],
  preTokens: unknown,
  postTokens: unknown,
  programs?: ReadonlyMap<string, string>,
) {
  if (
    before.length !== keys.length ||
    after.length !== keys.length ||
    keys[0] !== wallet ||
    new Set(keys).size !== keys.length
  )
    throw new Error('Signing requires complete native account balances.');
  const pre = warmupAccountTokens(keys, wallet, preTokens, programs),
    post = warmupAccountTokens(keys, wallet, postTokens, programs);
  let rentChange = 0n;
  // Observed wallet-owned token-account reserve deltas only, not gross
  // transaction spending. Foreign-owned/non-token accounts are outside this
  // scope. Accounts can be created and closed between snapshots. These sums
  // preserve opposing visible movements without claiming to recover that
  // hidden activity or allowing refunds to replenish execution authority.
  let observedWalletTokenReserveIncreases = 0n;
  let observedWalletTokenReserveDecreases = 0n;
  for (const index of new Set([...pre.keys(), ...post.keys()])) {
    const first = pre.get(index),
      last = post.get(index),
      mint = first?.mint ?? last!.mint;
    if (
      first &&
      last &&
      (first.mint !== last.mint ||
        first.decimals !== last.decimals ||
        first.program !== last.program)
    )
      throw new Error('Signing requires stable account mint identities.');
    const start = uint(before[index]),
      end = uint(after[index]);
    if ((!first && start !== 0n) || (!last && end !== 0n))
      throw new Error(
        'Signing requires complete created and closed account metadata.',
      );
    const firstRent =
      start - (mint === WARMUP_NATIVE ? (first?.amount ?? 0n) : 0n);
    const lastRent = end - (mint === WARMUP_NATIVE ? (last?.amount ?? 0n) : 0n);
    if (firstRent < 0n || lastRent < 0n)
      throw new Error('Signing requires valid native token reserves.');
    const change = lastRent - firstRent;
    rentChange += change;
    if (change > 0n) observedWalletTokenReserveIncreases += change;
    else observedWalletTokenReserveDecreases -= change;
  }
  return {
    pre,
    post,
    rentChange,
    observedWalletTokenReserveIncreases,
    observedWalletTokenReserveDecreases,
  };
}
function postToken(
  raw: unknown,
  mint: string,
  wallet: string,
  amount: bigint,
  lamports: bigint,
  program: string,
) {
  const account = raw as {
    owner?: unknown;
    executable?: unknown;
    data?: unknown;
    lamports?: unknown;
  };
  if (
    !account ||
    account.owner !== program ||
    account.executable !== false ||
    uint(account.lamports) !== lamports ||
    !Array.isArray(account.data) ||
    account.data.length !== 2 ||
    account.data[1] !== 'base64' ||
    typeof account.data[0] !== 'string'
  )
    throw new Error('Signing requires simulated standard token post-state.');
  const decoded = swapTokenBytes(account, false);
  const bytes = decoded.bytes,
    view = new DataView(bytes.buffer);
  if (
    bs58.encode(bytes.slice(0, 32)) !== mint ||
    bs58.encode(bytes.slice(32, 64)) !== wallet ||
    view.getBigUint64(64, true) !== amount ||
    bytes[108] !== 1 ||
    view.getUint32(72, true) !== 0 ||
    view.getBigUint64(121, true) !== 0n ||
    view.getUint32(129, true) !== 0
  )
    throw new Error(
      'Signing requires unchanged owner and no token authorities.',
    );
  const native = view.getUint32(109, true);
  if (
    native !== (mint === WARMUP_NATIVE ? 1 : 0) ||
    (native === 1 && view.getBigUint64(113, true) !== lamports - amount)
  )
    throw new Error('Signing requires matched native reserve.');
  return decoded;
}
export async function warmupAccountKeysHash(keys: readonly string[]) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(keys)),
      ),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export type WarmupSettlement = {
  accountKeysSha256: string;
  version: 1 | 2;
  token2022Evidence?: SwapToken2022Evidence;
  wrappedFromNativeRaw: string;
  maximumRentLamports: string;
  maximumNativeDebitLamports: string;
  preexistingWrappedRefundRaw: string;
  closesWrappedAccount: boolean;
  accounts: {
    address: string;
    mint: string;
    index: number;
    created: boolean;
    closed: boolean;
    rentBeforeRaw: string;
  }[];
  lookupTables: { address: string; sha256: string; lastExtendedSlot: string }[];
};
type NativeOrder = Pick<
  SolanaSwapPreparation,
  'side' | 'inputMint' | 'outputMint' | 'inAmount' | 'minimumOutAmount'
> & {
  preparation: Pick<
    SolanaSwapPreparation['preparation'],
    'wallet' | 'accountCount' | 'lookupTableCount'
  >;
};
export type NativeSettlementSimulation = Pick<
  ImportedSwapSimulation,
  | 'settlementEvidence'
  | 'instructionReview'
  | 'accountBindings'
  | 'nativeChangeRaw'
  | 'networkFeeLamports'
  | 'lookupObservation'
  | 'simulationSlot'
  | 'token2022Evidence'
> & {
  routeAssessment: {
    decoded: {
      sourceAccount: string;
      destinationAccount: string;
      v2?: boolean;
      inputTokenProgram?: string;
      outputTokenProgram?: string;
    } | null;
  };
};
export async function reviewWarmupSettlement(
  order: SolanaSwapPreparation,
  simulation: ImportedSwapSimulation,
): Promise<WarmupSettlement> {
  return (await reviewNativeSettlement(order, simulation, null)).settlement;
}
export async function reviewExactOutputNativeSettlement(
  order: JupiterExactOutOrder & {
    accountCount: number;
    lookupTableCount: number;
  },
  simulation: NativeSettlementSimulation,
  feeRentLimitRaw: string,
) {
  if (
    order.inputMint !== WARMUP_NATIVE ||
    order.outputMint === WARMUP_NATIVE ||
    uint(simulation.networkFeeLamports) < 1n ||
    uint(simulation.networkFeeLamports) > 1000000n
  )
    throw new Error(
      'ExactOut settlement requires a native Buy with bounded observed fees.',
    );
  const route = assessJupiterExactOutRoute(simulation.instructionReview, order);
  if (route.status !== 'Matched fields' || !route.decoded)
    throw new Error(
      'ExactOut native settlement requires matching declared route fields.',
    );
  const call = simulation.instructionReview.instructions.find(
    (i) => i.program.address === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  )!;
  const budgets = new Set<number>();
  for (const instruction of simulation.instructionReview.instructions) {
    if (
      instruction.program.address !==
      'ComputeBudget111111111111111111111111111111'
    )
      continue;
    const bytes = Uint8Array.from(instruction.dataHex.match(/../g) ?? [], (v) =>
        parseInt(v, 16),
      ),
      view = new DataView(bytes.buffer),
      tag = bytes[0];
    if (instruction.accounts.length || budgets.has(tag))
      throw new Error('ExactOut requires unique account-free compute budgets.');
    budgets.add(tag);
    if (
      tag === 2 &&
      bytes.length === 5 &&
      view.getUint32(1, true) >= 1 &&
      view.getUint32(1, true) <= 1400000
    )
      continue;
    if (tag === 3 && bytes.length === 9 && view.getBigUint64(1, true) === 0n)
      continue;
    if (
      tag === 1 &&
      bytes.length === 5 &&
      view.getUint32(1, true) >= 32768 &&
      view.getUint32(1, true) <= 262144 &&
      view.getUint32(1, true) % 1024 === 0
    )
      continue;
    if (
      tag === 4 &&
      bytes.length === 5 &&
      view.getUint32(1, true) >= 1 &&
      view.getUint32(1, true) <= 67108864
    )
      continue;
    throw new Error('ExactOut compute budget or priority fee is unsupported.');
  }
  const result = await reviewNativeSettlement(
    {
      side: 'Buy',
      inputMint: order.inputMint,
      outputMint: order.outputMint,
      inAmount: order.quotedInputRaw,
      minimumOutAmount: order.outputTargetRaw,
      preparation: {
        wallet: order.wallet,
        accountCount: order.accountCount,
        lookupTableCount: order.lookupTableCount,
      },
    },
    {
      ...simulation,
      routeAssessment: {
        decoded: {
          sourceAccount: call.accounts[3].address,
          destinationAccount: call.accounts[6].address,
        },
      },
    },
    {
      maximumInputRaw: order.maximumInputRaw,
      exactOutputRaw: order.outputTargetRaw,
      feeRentLimitRaw,
    },
  );
  if (!result.settlement.closesWrappedAccount)
    throw new Error(
      'ExactOut automatic wrapping requires wallet-bound cleanup.',
    );
  return {
    format: 'exact-output-native-settlement-v1' as const,
    executionAllowed: false as const,
    instructionsVerified: false as const,
    swapMode: 'ExactOut' as const,
    actualInputRaw: (-BigInt(result.nativeSettlementRaw)).toString(),
    rentChangeRaw: result.rentChangeRaw,
    settlement: result.settlement,
  };
}
async function reviewNativeSettlement(
  order: NativeOrder,
  simulation: NativeSettlementSimulation,
  exactOut: {
    maximumInputRaw: string;
    exactOutputRaw: string;
    feeRentLimitRaw: string;
  } | null,
) {
  const evidence = simulation.settlementEvidence,
    route = simulation.routeAssessment.decoded;
  if (
    !evidence ||
    !route ||
    simulation.accountBindings.accounts.length !== 2 ||
    simulation.instructionReview.unresolvedAccountCount
  )
    throw new Error('Signing requires fresh setup and settlement evidence.');
  const { keys, before, after } = evidence,
    wallet = order.preparation.wallet;
  const token2022Proof = simulation.token2022Evidence;
  if (
    [route.inputTokenProgram, route.outputTokenProgram].includes(
      SWAP_TOKEN_2022,
    ) &&
    !token2022Proof
  )
    throw new Error('Signing requires independent Token-2022 mint evidence.');
  const programs = token2022Proof
    ? swapToken2022Programs(token2022Proof, order, simulation.simulationSlot)
    : undefined;
  if (
    programs &&
    (route.v2 !== true ||
      route.inputTokenProgram !== programs.get(order.inputMint) ||
      route.outputTokenProgram !== programs.get(order.outputMint))
  )
    throw new Error(
      'Signing requires independently bound route token programs.',
    );
  if (
    simulation.nativeChangeRaw !== (uint(after[0]) - uint(before[0])).toString()
  )
    throw new Error('Signing requires consistent wallet debit evidence.');
  const rent = uint(evidence.rentLamports);
  if (
    rent < 1n ||
    rent > 3000000n ||
    keys.length !== order.preparation.accountCount
  )
    throw new Error('Signing requires bounded standard account rent.');
  const { pre, post, rentChange } = warmupRentChange(
    keys,
    wallet,
    before,
    after,
    evidence.preTokens,
    evidence.postTokens,
    programs,
  );
  if (
    !Array.isArray(evidence.postAccounts) ||
    evidence.postAccounts.length !== 2
  )
    throw new Error('Signing requires simulated account post-state.');
  const states = simulation.accountBindings.accounts.map(
    (binding, position) => {
      const index = keys.indexOf(binding.address),
        mint = position === 0 ? order.inputMint : order.outputMint,
        program = programs?.get(mint) ?? WARMUP_TOKEN,
        accountRent =
          program === SWAP_TOKEN_2022
            ? uint(token2022Proof!.rentLamports)
            : rent;
      if (
        binding.address !==
          (position === 0 ? route.sourceAccount : route.destinationAccount) ||
        binding.expectedMint !== mint ||
        index <= 0
      )
        throw new Error('Signing requires matched route account identities.');
      const initial = pre.get(index),
        final = post.get(index),
        start = uint(before[index]),
        end = uint(after[index]);
      const absent = binding.exists === false;
      if (
        absent
          ? start !== 0n || initial !== undefined
          : binding.status !== 'Matched bindings' ||
            binding.exists !== true ||
            binding.delegate !== null ||
            binding.closeAuthority !== null ||
            binding.delegatedAmountRaw !== '0' ||
            uint(binding.lamports) !== start ||
            !initial ||
            (binding.tokenProgram ?? WARMUP_TOKEN) !== program ||
            uint(binding.amountRaw) !== initial.amount
      )
        throw new Error(
          'Signing requires unencumbered token account pre-state.',
        );
      if ((initial && initial.mint !== mint) || (final && final.mint !== mint))
        throw new Error('Signing requires matching simulated mint bindings.');
      const declaredDecimals = token2022Proof?.mints.find(
        (m) => m.address === mint,
      )?.decimals;
      if (
        declaredDecimals !== undefined &&
        [initial, final].some((t) => t && t.decimals !== declaredDecimals)
      )
        throw new Error('Signing requires observed mint precision.');
      const firstRent =
        start - (mint === WARMUP_NATIVE ? (initial?.amount ?? 0n) : 0n);
      if (
        !absent &&
        (firstRent < 1n ||
          (mint === WARMUP_NATIVE
            ? uint(binding.nativeReserveRaw) !== firstRent
            : binding.nativeReserveRaw !== null))
      )
        throw new Error('Signing requires matched token rent reserves.');
      const postAccount = evidence.postAccounts![position] as {
        owner?: unknown;
        executable?: unknown;
        lamports?: unknown;
        data?: unknown;
      } | null;
      const closed =
        postAccount === null ||
        (postAccount.owner === SYSTEM &&
          postAccount.executable === false &&
          postAccount.lamports === '0' &&
          Array.isArray(postAccount.data) &&
          postAccount.data.length === 2 &&
          postAccount.data[0] === '' &&
          postAccount.data[1] === 'base64');
      if (closed ? end !== 0n || final !== undefined : !final)
        throw new Error('Signing requires complete cleanup metadata.');
      if (!closed) {
        const decodedPost = postToken(
          evidence.postAccounts![position],
          mint,
          wallet,
          final!.amount,
          end,
          program,
        );
        if (
          program === SWAP_TOKEN_2022 &&
          (absent
            ? decodedPost.bytes.length !== token2022Proof!.accountSize ||
              !decodedPost.extensions.includes('ImmutableOwner')
            : decodedPost.bytes.length !== binding.byteLength)
        )
          throw new Error(
            'Signing requires stable Token-2022 account allocation.',
          );
        if (
          end - (mint === WARMUP_NATIVE ? final!.amount : 0n) !==
          (absent ? accountRent : firstRent)
        )
          throw new Error('Signing requires unchanged account rent.');
      }
      return {
        binding,
        index,
        mint,
        program,
        accountRent,
        absent,
        closed,
        initial,
        final,
        firstRent,
        createdAt: -1,
        initializedAt: -1,
        fundedAt: -1,
        syncedAt: -1,
        closedAt: -1,
        seedCreation: false,
        funding: 0n,
      };
    },
  );
  if (
    states[0].index === states[1].index ||
    [...pre.keys(), ...post.keys()].some(
      (index) => !states.some((s) => s.index === index),
    )
  )
    throw new Error(
      'Signing requires only the two reviewed wallet token accounts.',
    );
  const instructions = simulation.instructionReview.instructions,
    routes = instructions.filter(
      (i) =>
        i.program.address === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    );
  if (routes.length !== 1)
    throw new Error('Signing requires one reviewed exact-input route.');
  const routeIndex = routes[0].index;
  let setupDebit = 0n;
  for (const instruction of instructions) {
    const program = instruction.program.address,
      a = instruction.accounts;
    if (instruction.program.signer || instruction.program.writable)
      throw new Error('Signing requires immutable program account privileges.');
    if (
      program === routes[0].program.address ||
      program === 'ComputeBudget111111111111111111111111111111'
    )
      continue;
    const bytes = Uint8Array.from(instruction.dataHex.match(/../g) ?? [], (v) =>
        parseInt(v, 16),
      ),
      view = new DataView(bytes.buffer);
    const target = states.find(
      (s) =>
        s.binding.address ===
        a[program === SYSTEM || program === ATA ? 1 : 0]?.address,
    );
    const fail = () => {
      throw new Error(
        'Signing requires supported setup, wrapping and cleanup instructions.',
      );
    };
    const payer = (i: number) =>
      a[i]?.address === wallet && a[i].signer && a[i].writable;
    const writable = (i: number) => a[i]?.writable && !a[i].signer;
    const readonly = (i: number, key: string) =>
      a[i]?.address === key && !a[i].signer && !a[i].writable;
    if (!target) fail();
    const s = target!;
    if (program === ATA) {
      if (
        instruction.index >= routeIndex ||
        ![6, 7].includes(a.length) ||
        !payer(0) ||
        !writable(1) ||
        a[2]?.address !== wallet ||
        !readonly(3, s.mint) ||
        !readonly(4, SYSTEM) ||
        !readonly(5, s.program) ||
        (a.length === 7 && !readonly(6, RENT)) ||
        !(bytes.length === 0 || (bytes.length === 1 && bytes[0] <= 1)) ||
        s.createdAt !== -1
      )
        fail();
      const [canonical] = await getProgramDerivedAddress({
        programAddress: address(ATA),
        seeds: [
          bs58.decode(wallet),
          bs58.decode(s.program),
          bs58.decode(s.mint),
        ],
      });
      if (
        canonical !== s.binding.address ||
        (!s.absent && !(bytes.length === 1 && bytes[0] === 1))
      )
        fail();
      s.createdAt = instruction.index;
      s.initializedAt = instruction.index;
      if (s.absent) setupDebit += s.accountRent;
    } else if (
      program === SYSTEM &&
      bytes.length === 12 &&
      view.getUint32(0, true) === 2
    ) {
      if (
        order.side !== 'Buy' ||
        s.mint !== WARMUP_NATIVE ||
        instruction.index >= routeIndex ||
        !payer(0) ||
        !writable(1) ||
        a.length !== 2 ||
        (s.fundedAt !== -1 && s.funding !== 0n) ||
        (s.absent && s.initializedAt === -1)
      )
        fail();
      s.funding = view.getBigUint64(4, true);
      s.fundedAt = instruction.index;
      setupDebit += s.funding;
    } else if (
      program === SYSTEM &&
      bytes.length >= 92 &&
      view.getUint32(0, true) === 3
    ) {
      const seedLength = view.getBigUint64(36, true),
        offset = 44 + Number(seedLength);
      if (
        seedLength > 32n ||
        bytes.length !== offset + 48 ||
        instruction.index >= routeIndex ||
        s.mint !== WARMUP_NATIVE ||
        !s.absent ||
        s.createdAt !== -1 ||
        !payer(0) ||
        !writable(1) ||
        ![2, 3].includes(a.length) ||
        (a.length === 3 && !payer(2)) ||
        bs58.encode(bytes.slice(4, 36)) !== wallet ||
        view.getBigUint64(offset + 8, true) !== 165n ||
        bs58.encode(bytes.slice(offset + 16)) !== WARMUP_TOKEN
      )
        fail();
      const derived = bs58.encode(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            Uint8Array.from([
              ...bs58.decode(wallet),
              ...bytes.slice(44, offset),
              ...bs58.decode(WARMUP_TOKEN),
            ]).buffer,
          ),
        ),
      );
      if (derived !== s.binding.address) fail();
      const funded = view.getBigUint64(offset, true);
      if (funded < rent) fail();
      s.createdAt = instruction.index;
      s.seedCreation = true;
      s.funding = funded - rent;
      s.fundedAt = instruction.index;
      setupDebit += funded;
    } else if (
      program === WARMUP_TOKEN &&
      ((bytes.length === 33 && [16, 18].includes(bytes[0])) ||
        (bytes.length === 1 && bytes[0] === 1))
    ) {
      if (
        !s.seedCreation ||
        s.initializedAt !== -1 ||
        instruction.index <= s.createdAt ||
        instruction.index >= routeIndex ||
        a.length !== (bytes[0] === 18 ? 2 : bytes[0] === 16 ? 3 : 4) ||
        !writable(0) ||
        !readonly(1, WARMUP_NATIVE) ||
        (bytes[0] === 1
          ? a[2]?.address !== wallet || !payer(2) || !readonly(3, RENT)
          : bs58.encode(bytes.slice(1)) !== wallet ||
            (bytes[0] === 16 && !readonly(2, RENT)))
      )
        fail();
      s.initializedAt = instruction.index;
    } else if (
      program === WARMUP_TOKEN &&
      bytes.length === 1 &&
      bytes[0] === 17
    ) {
      if (
        s.mint !== WARMUP_NATIVE ||
        instruction.index >= routeIndex ||
        s.syncedAt !== -1 ||
        s.fundedAt === -1 ||
        instruction.index <= s.fundedAt ||
        (s.absent && s.initializedAt === -1) ||
        a.length !== 1 ||
        !writable(0)
      )
        fail();
      s.syncedAt = instruction.index;
    } else if (
      program === WARMUP_TOKEN &&
      bytes.length === 1 &&
      bytes[0] === 9
    ) {
      if (
        s.mint !== WARMUP_NATIVE ||
        instruction.index <= routeIndex ||
        s.closedAt !== -1 ||
        !s.closed ||
        a.length !== 3 ||
        !writable(0) ||
        !payer(1) ||
        !payer(2)
      )
        fail();
      s.closedAt = instruction.index;
    } else fail();
  }
  for (const s of states) {
    if (
      (s.absent && (s.createdAt === -1 || s.initializedAt === -1)) ||
      s.closed !== (s.closedAt !== -1) ||
      (s.seedCreation && !s.closed)
    )
      throw new Error('Signing requires complete account setup and cleanup.');
    if (
      s.funding > 0n &&
      (order.side !== 'Buy' ||
        (exactOut
          ? s.funding > uint(exactOut.maximumInputRaw)
          : s.funding !== uint(order.inAmount)) ||
        (s.syncedAt === -1 && s.fundedAt > s.initializedAt))
    )
      throw new Error(
        'Signing requires exact SOL wrapping amount and synchronization.',
      );
    if (s.funding === 0n && s.syncedAt !== -1)
      throw new Error('Signing requires funded wrapping.');
    if (s.mint !== WARMUP_NATIVE) {
      const delta = (s.final?.amount ?? 0n) - (s.initial?.amount ?? 0n);
      if (
        order.side === 'Buy'
          ? exactOut
            ? delta !== uint(exactOut.exactOutputRaw)
            : delta < uint(order.minimumOutAmount)
          : delta !== -uint(order.inAmount)
      )
        throw new Error(
          'Simulated swap token units differ from the signing review.',
        );
    }
  }
  const wrapped = states.find((s) => s.mint === WARMUP_NATIVE);
  if (!wrapped) throw new Error('Signing requires a native SOL pair.');
  // Native + wrapped units + locked account rent + fee is the swap's SOL movement.
  const wrappedDelta =
    (wrapped.final?.amount ?? 0n) - (wrapped.initial?.amount ?? 0n);
  const effective =
    uint(after[0]) -
    uint(before[0]) +
    wrappedDelta +
    rentChange +
    uint(simulation.networkFeeLamports);
  if (
    order.side === 'Buy'
      ? exactOut
        ? effective >= 0n ||
          -effective > uint(exactOut.maximumInputRaw) ||
          -effective > wrapped.funding ||
          (wrapped.initial?.amount ?? 0n) !== 0n
        : effective !== -uint(order.inAmount)
      : effective < uint(order.minimumOutAmount)
  )
    throw new Error(
      'Network debit or minimum native output differs from the signing limit.',
    );
  const maximumRent = states.reduce(
    (sum, s) => sum + (s.absent ? s.accountRent : 0n),
    0n,
  );
  if (
    maximumRent > 6000000n ||
    (exactOut &&
      maximumRent + uint(simulation.networkFeeLamports) >
        uint(exactOut.feeRentLimitRaw)) ||
    uint(before[0]) < setupDebit + uint(simulation.networkFeeLamports)
  )
    throw new Error(
      'Signing requires sufficient SOL for wrapping, fees and rent.',
    );
  const tables = simulation.lookupObservation?.tables ?? [];
  if (
    tables.length !== order.preparation.lookupTableCount ||
    (tables.length &&
      (!simulation.lookupObservation ||
        simulation.lookupObservation.recheckSlot <
          simulation.simulationSlot)) ||
    tables.some((t) => !/^[a-f0-9]{64}$/.test(t.sha256))
  )
    throw new Error('Signing requires rechecked lookup tables.');
  const settlement: WarmupSettlement = {
    version: token2022Proof ? 2 : 1,
    ...(token2022Proof
      ? { token2022Evidence: structuredClone(token2022Proof) }
      : {}),
    accountKeysSha256: await warmupAccountKeysHash(keys),
    wrappedFromNativeRaw: wrapped.funding.toString(),
    maximumRentLamports: maximumRent.toString(),
    maximumNativeDebitLamports: (
      setupDebit + uint(simulation.networkFeeLamports)
    ).toString(),
    preexistingWrappedRefundRaw: (wrapped.closed
      ? (wrapped.initial?.amount ?? 0n)
      : 0n
    ).toString(),
    closesWrappedAccount: wrapped.closed,
    accounts: states.map((s) => ({
      address: s.binding.address,
      mint: s.mint,
      index: s.index,
      created: s.absent,
      closed: s.closed,
      rentBeforeRaw: s.firstRent.toString(),
    })),
    lookupTables: tables,
  };
  return {
    settlement,
    nativeSettlementRaw: effective.toString(),
    rentChangeRaw: rentChange.toString(),
  };
}
