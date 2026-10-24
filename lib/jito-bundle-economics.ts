import bs58 from 'bs58';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { requireJitoManifest, type JitoBundleManifest } from './jito-bundle';
import {
  verifyJitoBundleSimulationFrames,
  type JitoSimulationAccount,
} from './jito-bundle-simulation-frames';
import { decodeJitoWalletTokenBalances } from './jito-bundle-token-state';
import { matchingJitoSettlementPolicy } from './jito-settlement-policy';
import { requireWarmupSigningReview } from './warmup-signing';
import { warmupRentChange, WARMUP_NATIVE } from './warmup-native-settlement';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';
import { reviewSwapInstructions } from './swap-instruction-review';
import { assessJupiterRoute } from './jupiter-route-assessment';
import { assessSimulatedSwapTokens } from './simulated-swap-balances';
import { readSwapTokenAccountBindings } from './swap-token-account-bindings';
import {
  inspectSwapMintAccount,
  assertSameSwapMintEvidence,
  SWAP_TOKEN_2022,
  SWAP_TOKEN_2022_ACCOUNT_SIZE,
  supportedSwapTokenProgram,
} from './swap-token-program-evidence';
import { requireConsistentSolanaSlots } from './solana-rpc';
import { PUMP_GROUP_JITO_TIP_ACCOUNTS } from './pump-group-broadcast';
import type { ImportedSwapSimulation } from './imported-swap-simulation';
import type { SolanaSwapPreparation } from './warmup-swap-quote';
import {
  inspectPairRentAccount,
  pairRentMinimumRaw,
  PAIR_RENT,
} from './pair-rent-evidence';
const SYSTEM = '11111111111111111111111111111111';
export type JitoEconomicObservation = {
  order: SolanaSwapPreparation;
  simulation: ImportedSwapSimulation;
  mintAccounts: {
    slot: number;
    recheckSlot: number;
    before: unknown[];
    after: unknown[];
  };
};
const fail = (reason: string): never => {
  throw Error('Bundle economic observation: ' + reason + '.');
};
const uint = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    return fail('invalid amount');
  return BigInt(v);
};
const bank = (v: unknown) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    return fail('invalid evidence slot');
  return v;
};
/** Bounded parsed JSON copy before the first await. Never invoke own getters/toJSON.
 * The caller still has to bound the provider transport before parsing.
 * Caller-created Proxy traps are not detected by this parsed-JSON snapshot. */
function snapshot(value: unknown): unknown {
  const utf8 = new TextEncoder();
  let nodes = 0,
    bytes = 0;
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 32) return fail('input complexity bound');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return fail('non-JSON number');
      return v;
    }
    if (typeof v === 'string') {
      if (v.length > 8 * 1024 * 1024) return fail('input byte bound');
      bytes += utf8.encode(JSON.stringify(v)).length;
      if (bytes > 8 * 1024 * 1024) return fail('input byte bound');
      return v;
    }
    if (!v || typeof v !== 'object') return fail('non-JSON input');
    const array = Array.isArray(v);
    if (
      !array &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      return fail('non-JSON input');
    if (array && v.length > 4096) return fail('input array bound');
    const names = Object.getOwnPropertyNames(v).filter(
      (k) => !(array && k === 'length'),
    );
    if (
      names.length > 4096 ||
      Object.getOwnPropertySymbols(v).length ||
      (array &&
        (names.length !== v.length || names.some((k, i) => k !== String(i))))
    )
      return fail('input property bound');
    const out: Record<string, unknown> | unknown[] = array ? [] : {};
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(v, name)!;
      if (!d.enumerable || !Object.hasOwn(d, 'value'))
        return fail('input accessor refused');
      bytes += utf8.encode(JSON.stringify(name)).length;
      if (bytes > 8 * 1024 * 1024) return fail('input byte bound');
      Object.defineProperty(out, name, {
        value: copy(d.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  const captured = copy(value, 0);
  if (utf8.encode(JSON.stringify(captured)).length > 8 * 1024 * 1024)
    return fail('input byte bound');
  return captured;
}
const wire = (a: JitoSimulationAccount | null) =>
  a === null
    ? null
    : { ...a, data: [Buffer.from(a.data).toString('base64'), 'base64'] };
const sameAccount = (
  a: JitoSimulationAccount | null,
  b: JitoSimulationAccount | null,
) =>
  a === null || b === null
    ? a === b
    : a.owner === b.owner &&
      a.lamports === b.lamports &&
      a.executable === b.executable &&
      a.data.length === b.data.length &&
      a.data.every((v, i) => v === b.data[i]);
const tokenOwner = (a: JitoSimulationAccount | null, wallet: string) =>
  !!a &&
  supportedSwapTokenProgram(a.owner) &&
  a.data.length >= 64 &&
  bs58.encode(a.data.slice(32, 64)) === wallet;
function loadedFromObservation(o: JitoEconomicObservation) {
  const tx = getTransactionDecoder().decode(
    Uint8Array.from(Buffer.from(o.order.preparation.transaction, 'base64')),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (message.version !== 0)
    return fail('only original v0 swap messages supported');
  const keys = o.simulation.settlementEvidence?.keys;
  if (
    !keys ||
    keys[0] !== o.order.preparation.wallet ||
    !message.staticAccounts.every((key, i) => key === keys[i])
  )
    return fail('original account vector differs');
  const writable = (message.addressTableLookups ?? []).reduce(
    (n, t) => n + t.writableIndexes.length,
    0,
  );
  const readonly = (message.addressTableLookups ?? []).reduce(
    (n, t) => n + t.readonlyIndexes.length,
    0,
  );
  if (keys.length !== message.staticAccounts.length + writable + readonly)
    return fail('original lookup coverage differs');
  return {
    message,
    loadedAddresses: {
      writable: keys.slice(
        message.staticAccounts.length,
        message.staticAccounts.length + writable,
      ),
      readonly: keys.slice(message.staticAccounts.length + writable),
    },
  };
}
/** Replay raw sequential account effects against the exact supplied review policy.
 * Server-internal, unsigned and unmounted. Caller evidence is not authenticated here.
 * A passing local replay grants no provider, currentness, ownership, signing or execution authority. */
export async function verifyJitoBundleEconomicObservation(input: {
  manifest: JitoBundleManifest;
  observations: JitoEconomicObservation[];
  result: unknown;
  minimumSlot: number;
  simulationBankSlot: number;
  rentAccounts: {
    slot: number;
    recheckSlot: number;
    before: unknown;
    after: unknown;
  };
}) {
  // Capture the whole caller-owned observation before any asynchronous digest/decoder.
  // The future transport must independently bound bytes before parsing JSON.
  const captured = snapshot(input) as typeof input;
  if (
    !captured ||
    !Array.isArray(captured.observations) ||
    captured.observations.length < 1 ||
    captured.observations.length > 4
  )
    return fail('observation cardinality');
  const { manifest, observations, minimumSlot, simulationBankSlot } = captured;
  await requireJitoManifest(manifest, false);
  if (observations.length !== manifest.swaps.length)
    return fail('review cardinality');
  const parsed: ReturnType<typeof loadedFromObservation>[] = [];
  const slots = [
    bank(minimumSlot),
    bank(simulationBankSlot),
    bank(manifest.tip.slot),
  ];
  const rentEvidence = inspectPairRentAccount(captured.rentAccounts?.before);
  const rentRecheck = inspectPairRentAccount(captured.rentAccounts?.after);
  if (
    rentEvidence.dataBase64 !== rentRecheck.dataBase64 ||
    bank(captured.rentAccounts.slot) > simulationBankSlot ||
    bank(captured.rentAccounts.recheckSlot) < simulationBankSlot
  )
    return fail('Rent evidence does not bracket the bundle bank');
  slots.push(captured.rentAccounts.slot, captured.rentAccounts.recheckSlot);
  const systemReserve = uint(pairRentMinimumRaw(rentEvidence, 0));
  if (uint(manifest.tip.reserveLamports) < systemReserve)
    return fail('tip reserve below independently observed System minimum');
  const admittedMints = new Map<string, string>();
  for (let i = 0; i < observations.length; i++) {
    const { order, simulation } = observations[i],
      review = manifest.swaps[i];
    const envelope = await reviewUnsignedSwapEnvelope(
      order.preparation.transaction,
      review.wallet,
    );
    if (
      order.executionAllowed !== false ||
      order.preparation.executionAllowed !== false ||
      order.preparation.instructionsVerified !== false ||
      order.router !== 'metis' ||
      order.preparation.wallet !== review.wallet ||
      envelope.sha256 !== review.sha256 ||
      order.preparation.sha256 !== review.sha256 ||
      order.preparation.transaction !== review.transaction ||
      order.preparation.accountCount !== envelope.accountCount ||
      order.preparation.lookupTableCount !== envelope.lookupTableCount ||
      order.preparation.lastValidBlockHeight !== review.lastValidBlockHeight ||
      order.expiresAt !== review.expiresAt ||
      order.inputMint !== review.inputMint ||
      order.outputMint !== review.outputMint ||
      order.inAmount !== review.inputRaw ||
      order.minimumOutAmount !== review.minimumOutputRaw ||
      JSON.stringify(order.platformFee ?? null) !==
        JSON.stringify(review.platformFee ?? null) ||
      simulation.networkFeeLamports !== review.maximumFeeLamports ||
      (order.side === 'Buy'
        ? order.inputMint !== WARMUP_NATIVE ||
          order.outputMint === WARMUP_NATIVE
        : order.side !== 'Sell' ||
          order.outputMint !== WARMUP_NATIVE ||
          order.inputMint === WARMUP_NATIVE) ||
      order.side !== observations[0].order.side ||
      order.inputMint !== observations[0].order.inputMint ||
      order.outputMint !== observations[0].order.outputMint
    )
      return fail('order differs from exact reviewed packet');
    const baseline = await requireWarmupSigningReview(order, simulation);
    parsed.push(loadedFromObservation(observations[i]));
    if (!matchingJitoSettlementPolicy(review.settlement, baseline))
      return fail('original approved custody policy differs');
    slots.push(bank(simulation.feeSlot), bank(simulation.simulationSlot));
    if (simulation.accountBindings.slot !== null)
      slots.push(bank(simulation.accountBindings.slot));
    if (simulation.lookupObservation)
      slots.push(
        bank(simulation.lookupObservation.slot),
        bank(simulation.lookupObservation.recheckSlot),
      );
    if (simulation.simulationSlot > simulationBankSlot)
      return fail('bundle precedes prior swap observation');
  }
  const checked = await verifyJitoBundleSimulationFrames({
    minimumSlot,
    simulationBankSlot,
    packets: [
      ...observations.map((o, i) => ({
        transaction: manifest.swaps[i].transaction,
        loadedAddresses: parsed[i].loadedAddresses,
        maximumFeeLamports: manifest.swaps[i].maximumFeeLamports,
        expectedFeeLamports: o.simulation.networkFeeLamports,
      })),
      {
        transaction: manifest.tip.transaction,
        loadedAddresses: null,
        maximumFeeLamports: manifest.tip.feeLamports,
        expectedFeeLamports: manifest.tip.feeLamports,
      },
    ],
    result: captured.result,
  });
  const allWallets = manifest.swaps.map((r) => r.wallet);
  const outcomes = [];
  const initial = new Map<string, JitoSimulationAccount | null>(),
    final = new Map<string, JitoSimulationAccount | null>();
  for (const frame of checked.frames) {
    const payer = frame.keys[0];
    const afterPayer = uint(frame.postAccounts[0]!.lamports);
    if (afterPayer !== 0n && afterPayer < systemReserve)
      return fail('payer ends below independently observed System minimum');
    const rentIndex = frame.keys.indexOf(PAIR_RENT);
    if (
      rentIndex >= 0 &&
      [frame.preAccounts[rentIndex], frame.postAccounts[rentIndex]].some(
        (a) =>
          inspectPairRentAccount(wire(a)).dataBase64 !==
          rentEvidence.dataBase64,
      )
    )
      return fail('in-frame Rent differs');
    for (let k = 0; k < frame.keys.length; k++) {
      const key = frame.keys[k],
        before = frame.preAccounts[k],
        after = frame.postAccounts[k];
      if (!initial.has(key)) initial.set(key, before);
      final.set(key, after);
      for (const wallet of allWallets)
        if (
          wallet !== payer &&
          (key === wallet ||
            tokenOwner(before, wallet) ||
            tokenOwner(after, wallet)) &&
          !sameAccount(before, after)
        )
          return fail('another selected wallet changed in this packet');
    }
  }
  for (let i = 0; i < observations.length; i++) {
    const { order, simulation, mintAccounts } = observations[i],
      frame = checked.frames[i],
      review = manifest.swaps[i];
    if (
      !mintAccounts ||
      !Array.isArray(mintAccounts.before) ||
      !Array.isArray(mintAccounts.after) ||
      mintAccounts.before.length !== 2 ||
      mintAccounts.after.length !== 2
    )
      return fail('independent mint coverage missing');
    const beforeSlot = bank(mintAccounts.slot),
      afterSlot = bank(mintAccounts.recheckSlot);
    if (beforeSlot > checked.slot || afterSlot < checked.slot)
      return fail('mint evidence does not bracket bundle bank');
    slots.push(beforeSlot, afterSlot);
    const addresses = [order.inputMint, order.outputMint];
    const before = {
      slot: beforeSlot,
      mints: await Promise.all(
        mintAccounts.before.map((a, n) =>
          inspectSwapMintAccount(a, addresses[n]),
        ),
      ),
    };
    const after = {
      slot: afterSlot,
      mints: await Promise.all(
        mintAccounts.after.map((a, n) =>
          inspectSwapMintAccount(a, addresses[n]),
        ),
      ),
    };
    assertSameSwapMintEvidence(before, after);
    for (const mint of before.mints) {
      const identity = JSON.stringify(mint);
      if (
        admittedMints.has(mint.address) &&
        admittedMints.get(mint.address) !== identity
      )
        return fail('mint policy changed between packet observations');
      admittedMints.set(mint.address, identity);
    }
    for (const mint of before.mints) {
      const original = simulation.tokenChanges.find(
        (t) => t.mint === mint.address,
      );
      if (
        original &&
        (original.program !== mint.program ||
          original.decimals !== mint.decimals)
      )
        return fail(
          'independent mint differs from original precision or program',
        );
    }
    for (let n = 0; n < addresses.length; n++) {
      const at = frame.keys.indexOf(addresses[n]);
      if (at < 0) continue;
      for (const state of [frame.preAccounts[at], frame.postAccounts[at]]) {
        const observed = await inspectSwapMintAccount(
          wire(state),
          addresses[n],
        );
        if (JSON.stringify(observed) !== JSON.stringify(before.mints[n]))
          return fail('in-frame mint policy differs');
      }
    }
    const instructionReview = reviewSwapInstructions(
      parsed[i].message,
      frame.loadedAddresses,
    );
    const routeAssessment = assessJupiterRoute(instructionReview, order);
    if (!routeAssessment.decoded || routeAssessment.status !== 'Matched fields')
      return fail('bundle route could not be decoded');
    const accountBindings = await readSwapTokenAccountBindings(
      routeAssessment,
      order,
      checked.slot,
      async (method, params) => {
        if (method !== 'getMultipleAccounts' || !Array.isArray(params[0]))
          return fail('unexpected local binding read');
        return {
          context: { slot: String(checked.slot) },
          value: params[0].map((address) => {
            const index = frame.keys.indexOf(String(address));
            if (index < 0) return fail('route binding absent from frame');
            return wire(frame.preAccounts[index]);
          }),
        };
      },
    );
    accountBindings.limitations =
      'Derived from the sequential simulated pre-state only; no chain-source authority.';
    const preTokens = decodeJitoWalletTokenBalances(
        frame.keys,
        frame.preAccounts,
        review.wallet,
        before.mints,
      ),
      postTokens = decodeJitoWalletTokenBalances(
        frame.keys,
        frame.postAccounts,
        review.wallet,
        before.mints,
      );
    const tokens = assessSimulatedSwapTokens(
      order,
      parsed[i].message.staticAccounts,
      parsed[i].message.addressTableLookups ?? [],
      {
        loadedAddresses: frame.loadedAddresses,
        preTokenBalances: preTokens,
        postTokenBalances: postTokens,
      },
    );
    const modern = before.mints.some((m) => m.program === SWAP_TOKEN_2022);
    if (
      modern !== (review.settlement?.version === 2) ||
      modern !== Boolean(simulation.token2022Evidence)
    )
      return fail('Token-2022 review version differs');
    if (modern && !simulation.token2022Evidence)
      return fail('reviewed Token-2022 rent evidence missing');
    const sequential: ImportedSwapSimulation = {
      ...simulation,
      ...tokens,
      succeeded: true,
      simulationSlot: checked.slot,
      networkFeeLamports: frame.feeLamports,
      unitsConsumed: String(frame.unitsConsumed),
      nativeChangeRaw: (
        uint(frame.postAccounts[0]!.lamports) -
        uint(frame.preAccounts[0]!.lamports)
      ).toString(),
      instructionReview,
      routeAssessment,
      accountBindings,
      ...(modern
        ? {
            token2022Evidence: {
              format: 'swap-token-2022-evidence-v1' as const,
              ...before,
              recheckSlot: afterSlot,
              accountSize: SWAP_TOKEN_2022_ACCOUNT_SIZE,
              rentLamports: simulation.token2022Evidence!.rentLamports,
            },
          }
        : {}),
      settlementEvidence: {
        keys: frame.keys,
        before: frame.preAccounts.map((a) => a?.lamports ?? '0'),
        after: frame.postAccounts.map((a) => a?.lamports ?? '0'),
        preTokens,
        postTokens,
        postAccounts: [
          routeAssessment.decoded.sourceAccount,
          routeAssessment.decoded.destinationAccount,
        ].map((key) => wire(frame.postAccounts[frame.keys.indexOf(key)])),
        rentLamports: simulation.settlementEvidence!.rentLamports,
      },
    };
    if (!modern) delete sequential.token2022Evidence;
    if (
      sequential.settlementEvidence!.rentLamports !==
        pairRentMinimumRaw(rentEvidence, 165) ||
      (modern &&
        sequential.token2022Evidence!.rentLamports !==
          pairRentMinimumRaw(rentEvidence, 170))
    )
      return fail(
        'token rent differs from independently observed Rent profile',
      );
    const policy = await requireWarmupSigningReview(order, sequential);
    if (!matchingJitoSettlementPolicy(review.settlement, policy))
      return fail('sequential custody or debit policy differs');
    if (
      uint(frame.preAccounts[0]!.lamports) -
        uint(frame.postAccounts[0]!.lamports) >
      uint(policy.maximumNativeDebitLamports)
    )
      return fail('observed native debit exceeds approved policy');
    const programs = new Map(before.mints.map((m) => [m.address, m.program]));
    const rent = warmupRentChange(
      frame.keys,
      review.wallet,
      sequential.settlementEvidence!.before,
      sequential.settlementEvidence!.after,
      preTokens,
      postTokens,
      programs,
    );
    const wrappedIndex = policy.accounts.find(
      (a) => a.mint === WARMUP_NATIVE,
    )!.index;
    const wrappedChange =
      (rent.post.get(wrappedIndex)?.amount ?? 0n) -
      (rent.pre.get(wrappedIndex)?.amount ?? 0n);
    const native =
      BigInt(sequential.nativeChangeRaw!) +
      wrappedChange +
      rent.rentChange +
      uint(frame.feeLamports);
    const tokenOutput = tokens.tokenChanges
      .filter((t) => t.mint === order.outputMint)
      .reduce((n, t) => n + BigInt(t.changeRaw), 0n);
    const output = order.side === 'Buy' ? tokenOutput : native;
    uint(output.toString());
    if (output < uint(review.minimumOutputRaw))
      return fail('sequential output below original minimum');
    const needed =
      uint(policy.maximumNativeDebitLamports) +
      (i === 0
        ? uint(manifest.tip.maximumDebitRaw) +
          uint(manifest.tip.reserveLamports)
        : 0n);
    if (uint(frame.preAccounts[0]!.lamports) < needed)
      return fail('upfront funding relies on earlier proceeds');
    outcomes.push({
      packet: i,
      wallet: review.wallet,
      sha256: review.sha256,
      side: order.side,
      inputMint: order.inputMint,
      outputMint: order.outputMint,
      inputRaw: review.inputRaw,
      minimumOutputRaw: review.minimumOutputRaw,
      observedOutputRaw: output.toString(),
      networkFeeLamports: frame.feeLamports,
      rentChangeRaw: rent.rentChange.toString(),
      maximumNativeDebitLamports: policy.maximumNativeDebitLamports,
      preWalletLamports: frame.preAccounts[0]!.lamports,
      postWalletLamports: frame.postAccounts[0]!.lamports,
    });
  }
  const tip = manifest.tip,
    last = checked.frames.at(-1)!;
  if (
    !(PUMP_GROUP_JITO_TIP_ACCOUNTS as readonly string[]).includes(
      tip.recipient,
    ) ||
    allWallets.includes(tip.recipient) ||
    last.keys.length !== 3 ||
    last.keys[0] !== tip.wallet ||
    last.keys[1] !== tip.recipient ||
    last.keys[2] !== SYSTEM
  )
    return fail('tip destination or account vector differs');
  const firstRecipient = last.preAccounts[1],
    lastRecipient = last.postAccounts[1];
  const ordinary = (a: JitoSimulationAccount | null) =>
    a !== null && a.owner === SYSTEM && !a.executable && a.data.length === 0;
  if (
    !ordinary(firstRecipient) ||
    !ordinary(lastRecipient) ||
    uint(lastRecipient!.lamports) - uint(firstRecipient?.lamports ?? '0') !==
      uint(tip.amountRaw) ||
    uint(last.preAccounts[0]!.lamports) -
      uint(last.postAccounts[0]!.lamports) !==
      uint(tip.maximumDebitRaw) ||
    uint(last.postAccounts[0]!.lamports) < uint(tip.reserveLamports)
  )
    return fail('exact tip debit credit fee or reserve differs');
  requireConsistentSolanaSlots(slots);
  const keys = [...initial.keys()];
  const mintPolicies = await Promise.all(
    observations[0].mintAccounts.before.map((a, i) =>
      inspectSwapMintAccount(
        a,
        [observations[0].order.inputMint, observations[0].order.outputMint][i],
      ),
    ),
  );
  const mintPolicyMap = new Map(mintPolicies.map((m) => [m.address, m]));
  function vaultIdentity(account: JitoSimulationAccount | null) {
    if (
      !account ||
      !supportedSwapTokenProgram(account.owner) ||
      account.data.length < 165 ||
      (account.data.length !== 165 && account.data[165] !== 2)
    )
      return null;
    const mint = bs58.encode(account.data.slice(0, 32));
    if (!mintPolicyMap.has(mint)) return null;
    const view = new DataView(
      account.data.buffer,
      account.data.byteOffset,
      account.data.byteLength,
    );
    return {
      mint,
      program: account.owner,
      amount: view.getBigUint64(64, true),
      reserve: view.getBigUint64(113, true),
    };
  }
  function emptySystem(account: JitoSimulationAccount | null) {
    return !account || (ordinary(account) && account.data.length === 0);
  }
  // Parse all observed vault amounts for these two mints, not only wallet rows.
  // Foreign ownership/delegation is not wallet authority and is not admitted here.
  function pairUnits(accounts: Iterable<JitoSimulationAccount | null>) {
    const totals = new Map<string, bigint>();
    for (const account of accounts) {
      if (
        !account ||
        !supportedSwapTokenProgram(account.owner) ||
        account.data.length < 165 ||
        (account.data.length !== 165 && account.data[165] !== 2)
      )
        continue;
      const mint = bs58.encode(account.data.slice(0, 32)),
        policy = mintPolicyMap.get(mint);
      if (!policy) continue;
      const view = new DataView(
        account.data.buffer,
        account.data.byteOffset,
        account.data.byteLength,
      );
      if (
        account.owner !== policy.program ||
        account.executable ||
        account.data.length > 16384 ||
        (account.owner !== SWAP_TOKEN_2022 && account.data.length !== 165) ||
        ![1, 2].includes(account.data[108]) ||
        view.getUint32(72, true) > 1 ||
        view.getUint32(129, true) > 1
      )
        return fail('observed native-pair vault is invalid');
      const amount = view.getBigUint64(64, true),
        native = view.getUint32(109, true);
      if (
        mint === WARMUP_NATIVE
          ? native !== 1 ||
            uint(account.lamports) !== amount + view.getBigUint64(113, true)
          : native !== 0
      )
        return fail('observed native-pair vault backing differs');
      const total = (totals.get(mint) ?? 0n) + amount;
      if (total > (1n << 64n) - 1n)
        return fail('observed native-pair units exceed u64');
      totals.set(mint, total);
    }
    return totals;
  }
  function supply(account: JitoSimulationAccount | null | undefined) {
    if (!account || account.data.length < 82)
      return fail('in-frame mint supply unavailable');
    return new DataView(
      account.data.buffer,
      account.data.byteOffset,
      account.data.byteLength,
    ).getBigUint64(36, true);
  }
  for (const frame of checked.frames) {
    const before = pairUnits(frame.preAccounts),
      after = pairUnits(frame.postAccounts);
    for (let i = 0; i < frame.keys.length; i++) {
      const pre = frame.preAccounts[i],
        post = frame.postAccounts[i],
        a = vaultIdentity(pre),
        b = vaultIdentity(post);
      if (a && b) {
        if (
          a.mint !== b.mint ||
          a.program !== b.program ||
          (a.mint === WARMUP_NATIVE && a.reserve !== b.reserve)
        )
          return fail('native-pair vault identity or reserve changed');
      } else if (a) {
        if (
          !emptySystem(post) ||
          (post && uint(post.lamports) !== 0n) ||
          (a.mint !== WARMUP_NATIVE && a.amount !== 0n)
        )
          return fail('native-pair vault disappeared without a clean close');
      } else if (b) {
        const uninitialized =
          pre &&
          pre.owner === b.program &&
          !pre.executable &&
          pre.data.length >= 165 &&
          pre.data[108] === 0 &&
          pre.data.every((byte) => byte === 0);
        if (!emptySystem(pre) && !uninitialized)
          return fail('native-pair vault replaced a different account');
      }
    }
    for (const mint of mintPolicies) {
      if (mint.address === WARMUP_NATIVE) continue;
      const index = frame.keys.indexOf(mint.address);
      const supplyChange =
        index < 0
          ? 0n
          : supply(frame.postAccounts[index]) -
            supply(frame.preAccounts[index]);
      if (
        (after.get(mint.address) ?? 0n) - (before.get(mint.address) ?? 0n) !==
        supplyChange
      )
        return fail(
          'non-native vault units do not conserve against mint supply',
        );
    }
  }
  // Necessary consistency bound for mint state actually present in this vector.
  // Selected balances are only a subset of supply; this is not a supply audit.
  const supplyCheckedMints = mintPolicies
    .filter((m) => m.address !== WARMUP_NATIVE && initial.has(m.address))
    .map((m) => m.address);
  function checkSupply(state: Map<string, JitoSimulationAccount | null>) {
    const totals = pairUnits(state.values());
    for (const mint of supplyCheckedMints) {
      const account = state.get(mint);
      if (!account || account.data.length < 82)
        return fail('in-frame mint supply unavailable');
      const supply = new DataView(
        account.data.buffer,
        account.data.byteOffset,
        account.data.byteLength,
      ).getBigUint64(36, true);
      if ((totals.get(mint) ?? 0n) > supply)
        return fail('observed token balances exceed in-frame mint supply');
    }
  }
  const state = new Map(initial);
  checkSupply(state);
  for (const frame of checked.frames) {
    frame.keys.forEach((key, i) => state.set(key, frame.postAccounts[i]));
    checkSupply(state);
  }
  const walletStates = allWallets.map((wallet) => {
    const ownedKeys = keys.filter(
      (key) =>
        key === wallet ||
        tokenOwner(initial.get(key)!, wallet) ||
        tokenOwner(final.get(key)!, wallet),
    );
    return {
      wallet,
      accountKeys: ownedKeys,
      initialSolRaw: initial.get(wallet)!.lamports,
      finalSolRaw: final.get(wallet)!.lamports,
      initialTokenAccounts: decodeJitoWalletTokenBalances(
        ownedKeys,
        ownedKeys.map((k) => initial.get(k)!),
        wallet,
        mintPolicies,
      ).map((t) => ({ ...t, address: ownedKeys[Number(t.accountIndex)] })),
      finalTokenAccounts: decodeJitoWalletTokenBalances(
        ownedKeys,
        ownedKeys.map((k) => final.get(k)!),
        wallet,
        mintPolicies,
      ).map((t) => ({ ...t, address: ownedKeys[Number(t.accountIndex)] })),
    };
  });
  return {
    format: 'jito-bundle-economic-observation-v1' as const,
    manifestSha256: manifest.sha256,
    slot: checked.slot,
    orderedMessageHashes: checked.frames.map((f) => f.messageSha256),
    outcomes,
    tip: {
      wallet: tip.wallet,
      recipient: tip.recipient,
      amountRaw: tip.amountRaw,
      networkFeeLamports: last.feeLamports,
    },
    minimumSystemReserveLamports: systemReserve.toString(),
    walletStateScope:
      'only touched System payers and selected native-pair SPL/Token-2022 accounts' as const,
    outputScope:
      'minimum-bound raw swap units; Sell SOL adjusts network fee, visible rent and wrapped balances; not P&L or receipt' as const,
    upfrontFundingScope:
      'pre-state sufficient assuming debits remain within policy; not an intra-transaction gross debit trace' as const,
    networkFeeLamports: checked.frames
      .reduce((n, f) => n + uint(f.feeLamports), 0n)
      .toString(),
    walletStates,
    supplyCheckedMints,
    tokenConservationCheckedMints: mintPolicies
      .filter((m) => m.address !== WARMUP_NATIVE)
      .map((m) => m.address),
    frameEconomicChecksPassed: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    automaticExecutionAllowed: false as const,
    providerQualified: false as const,
    networkVerified: false as const,
    sourceCurrent: false as const,
    signatureVerified: false as const,
    altStateVerified: false as const,
    runtimePrivilegesVerified: false as const,
    receiptVerified: false as const,
  };
}
