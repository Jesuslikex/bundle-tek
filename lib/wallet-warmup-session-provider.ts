import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { prepareSolanaSwap, WRAPPED_SOL } from './warmup-swap-quote';
import { simulateImportedSwap } from './imported-swap-simulation';
import { inspectWarmupSellInventory } from './warmup-sell-inventory';
import { warmupBuyLink } from './warmup-buy-link';
import type { SavedWarmupBuyReceipt } from './warmup-buy-receipt';
import { warmupAtoms, warmupBuyAmount } from './wallet-warmup';
import { formatNativeBalance } from './wallet-balance-format';
import { warmupPreparationSummary } from './warmup-preparation-history';
import type { WarmupSessionPreparationCandidate } from './wallet-warmup-session-preparation';
import { SWAP_TOKEN, SWAP_TOKEN_2022 } from './swap-token-program-evidence';

// A25s cooperative request deadline and longer owner cooldown constrain provider
// reads. They cannot cancel an already accepted remote request or database write.
export const WARMUP_SESSION_PREPARATION_TIMEOUT_MS = 25000;
export const WARMUP_SESSION_PROVIDER_COOLDOWN_MS = 30000;
export class WalletWarmupSessionProviderError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const fail = (
  message = 'Fresh unsigned preparation could not be established. Recover the same request ID before retrying.',
  status = 409,
): never => {
  throw new WalletWarmupSessionProviderError(message, status);
};
const uint = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    return fail();
  return BigInt(value);
};
const signed = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^(0|-?[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) < -((1n << 64n) - 1n) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    return fail('Native or token balance evidence is unavailable.');
  return BigInt(value);
};
type Dependencies = {
  quote?: typeof prepareSolanaSwap;
  simulate?: typeof simulateImportedSwap;
  inventory?: typeof inspectWarmupSellInventory;
  now?: () => number;
};
type ReceiptRow = Omit<SavedWarmupBuyReceipt, 'document'> & {
  document: string;
};
/** Trusted server callback only. No history write, signature, send or execution authority. */
export function createWalletWarmupSessionProvider(
  db: D1Database,
  owner: string,
  apiKey: string | undefined,
  deps: Dependencies = {},
) {
  const quote = deps.quote ?? prepareSolanaSwap,
    simulate = deps.simulate ?? simulateImportedSwap,
    inventoryRead = deps.inventory ?? inspectWarmupSellInventory,
    now = deps.now ?? Date.now;
  return async (
    value: WarmupSessionPreparationCandidate,
    parentSignal: AbortSignal,
  ) => {
    const c = structuredClone(value),
      a = c.action;
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(owner) ||
      c.plan.archived ||
      c.plan.document.chain !== 'Solana' ||
      !Number.isSafeInteger(c.deadline) ||
      c.deadline <= now()
    )
      return fail();
    if (!apiKey || apiKey.length > 1000 || /\s/.test(apiKey))
      return fail('Unsigned preparation provider is not configured.', 503);
    const signal = AbortSignal.any([
      parentSignal,
      AbortSignal.timeout(
        Math.min(WARMUP_SESSION_PREPARATION_TIMEOUT_MS, c.deadline - now()),
      ),
    ]);
    const plan = c.plan.document;
    if (
      canonical(JSON.parse(c.planDocument)) !== canonical(plan) ||
      !plan.addresses.includes(a.wallet) ||
      plan.walletRevisions.find((w) => w.address === a.wallet)?.revision !==
        a.walletRevision ||
      !Number.isSafeInteger(a.cycle) ||
      a.cycle < 1 ||
      a.cycle > plan.cycles ||
      a.mint !== plan.tokens[(a.cycle - 1) % plan.tokens.length] ||
      a.mint === WRAPPED_SOL
    )
      return fail();
    const context = {
      planId: c.plan.id,
      planRevision: c.plan.revision,
      cycle: a.cycle,
      wallet: a.wallet,
      walletRevision: a.walletRevision,
      mint: a.mint,
    };
    const loadReceipt = async () => {
      signal.throwIfAborted();
      if (!c.sellSource) return null;
      const row = await db
        .prepare(
          'SELECT id,preparation_id AS preparationId,plan_id AS planId,plan_revision AS planRevision,cycle,wallet_revision AS walletRevision,created_at AS createdAt,remaining_raw AS remainingRaw,document FROM warmup_buy_receipts WHERE owner_id=? AND id=?',
        )
        .bind(owner, c.sellSource.buyReceiptId)
        .first<ReceiptRow>();
      signal.throwIfAborted();
      if (!row)
        return fail(
          'The approved buy lot is unavailable. Recover its history.',
        );
      if (row.remainingRaw == null)
        return fail(
          'The approved buy lot has no current remaining-unit record. Refresh its history.',
        );
      const receipt = {
        ...row,
        document: JSON.parse(row.document),
      } as SavedWarmupBuyReceipt;
      const link = warmupBuyLink(receipt, context);
      if (
        link.remainingRaw !== c.sellSource.remainingRaw ||
        link.decimals !== c.sellSource.decimals ||
        (a.side === 'Sell' &&
          a.source.kind === 'session-buy' &&
          link.remainingRaw !== link.acquiredRaw)
      )
        return fail(
          'The approved buy lot changed. Refresh the session review.',
        );
      return receipt;
    };
    const receipt = await loadReceipt();
    const current = async () => {
      signal.throwIfAborted();
      if (now() >= c.deadline)
        return fail(
          'The session review expired. No new preparation is allowed.',
        );
      const row = await db
        .prepare(
          "SELECT p.document FROM wallet_warmup_plans p JOIN wallet_warmup_session_journal_heads h ON h.owner_id=p.owner_id WHERE p.owner_id=? AND p.id=? AND p.revision=? AND p.updated_at=? AND p.archived=0 AND h.journal_id=? AND h.version=? AND h.head_sha256=? AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') AND w.chain='Solana' AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses'))",
        )
        .bind(
          owner,
          c.plan.id,
          c.plan.revision,
          c.plan.updatedAt,
          c.journalId,
          c.version,
          c.headSha256,
        )
        .first<{ document: string }>();
      signal.throwIfAborted();
      if (!row || row.document !== c.planDocument)
        return fail(
          'Saved session, plan or wallets changed. Recover the current status.',
        );
      if (receipt && canonical(await loadReceipt()) !== canonical(receipt))
        return fail(
          'The approved buy lot changed. Recover its current history.',
        );
    };
    let raw: string, decimals: number;
    if (a.side === 'Buy') {
      if (
        c.sellSource !== null ||
        uint(a.inputLamports) <= 0n ||
        warmupAtoms(warmupBuyAmount(plan, a.wallet, a.cycle), 9) !==
          uint(a.inputLamports)
      )
        return fail();
      raw = a.inputLamports;
      decimals = 9;
      if (
        BigInt(c.budget.recordedFurtherBuySpendLamports) + BigInt(raw) >
        BigInt(c.budget.buySpendLamports)
      )
        return fail('The approved buy budget is exhausted.');
    } else {
      if (!c.sellSource || !receipt || uint(c.sellSource.remainingRaw) <= 0n)
        return fail();
      raw = c.sellSource.remainingRaw;
      decimals = c.sellSource.decimals;
    }
    const reserve = uint(c.budget.remainingReserveLamports);
    if (reserve === 0n) return fail('The approved fee budget is exhausted.');
    await current();
    // This is a cooldown, not a funds reservation or an execution lease.
    const at = now();
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(owner, at + WARMUP_SESSION_PROVIDER_COOLDOWN_MS, at)
      .run();
    signal.throwIfAborted();
    if (!gate.meta.changes)
      return fail(
        'A wallet read or preparation is still cooling down. Recover the same request ID and wait before retrying.',
        429,
      );
    await current();
    const amount = formatNativeBalance(raw, decimals);
    const inventory =
      a.side === 'Sell'
        ? await inventoryRead(a.wallet, a.mint, signal, amount)
        : undefined;
    if (
      inventory &&
      (!inventory.preparationSupported ||
        !inventory.amountCovered ||
        inventory.decimals !== decimals ||
        inventory.requestedRaw !== raw ||
        inventory.executionAllowed !== false ||
        Date.parse(inventory.expiresAt) <= now())
    )
      return fail(
        'Fresh unfrozen holdings do not cover the exact approved sell input.',
      );
    const buyLink =
      receipt && inventory
        ? warmupBuyLink(receipt, context, inventory)
        : undefined;
    await current();
    const order = await quote(
      { tokenMint: a.mint, side: a.side, amount, decimals, wallet: a.wallet },
      apiKey,
      signal,
    );
    signal.throwIfAborted();
    if (
      order.side !== a.side ||
      order.inAmount !== raw ||
      order.preparation.wallet !== a.wallet ||
      order.inputMint !== (a.side === 'Buy' ? WRAPPED_SOL : a.mint) ||
      order.outputMint !== (a.side === 'Sell' ? WRAPPED_SOL : a.mint) ||
      !Number.isFinite(Date.parse(order.expiresAt)) ||
      Date.parse(order.expiresAt) <= now()
    )
      return fail('Provider order differs from the exact approved action.');
    await current();
    const simulation = await simulate(order, signal);
    signal.throwIfAborted();
    if (
      !simulation.succeeded ||
      simulation.sha256 !== order.preparation.sha256 ||
      simulation.wallet !== a.wallet ||
      !simulation.tokensComplete ||
      (a.side === 'Buy'
        ? simulation.minimumOutputCovered !== true ||
          simulation.inputAmountMatches === false
        : simulation.inputAmountMatches !== true ||
          simulation.minimumOutputCovered === false)
    )
      return fail(
        'Independent simulation cannot establish the required action evidence.',
      );
    // Provider total already includes signature+priority+rent. Replace only its
    // network component with the larger independently observed network fee.
    const estimates = order.preparation.estimates;
    const network =
        uint(estimates.signatureFeeLamports) +
        uint(estimates.prioritizationFeeLamports),
      rent = uint(estimates.rentFeeLamports),
      fee = uint(simulation.networkFeeLamports),
      feeBound = (network > fee ? network : fee) + rent;
    if (
      network + rent !== uint(order.preparation.estimatedFeesLamports) ||
      feeBound > reserve
    )
      return fail('Estimated fees and rent exceed the approved fee budget.');
    const changes = simulation.tokenChanges;
    const selected = changes.filter((t) => t.mint === a.mint),
      wrapped = changes.filter((t) => t.mint === WRAPPED_SOL);
    if (
      selected.length !== 1 ||
      ![SWAP_TOKEN, SWAP_TOKEN_2022].includes(selected[0].program) ||
      wrapped.length > 1 ||
      wrapped.some((t) => t.program !== SWAP_TOKEN || t.decimals !== 9) ||
      changes.some(
        (t) =>
          t.mint !== a.mint &&
          t.mint !== WRAPPED_SOL &&
          signed(t.changeRaw) !== 0n,
      )
    )
      return fail('Simulation changes unrelated or ambiguous token balances.');
    const delta = signed(selected[0].changeRaw);
    if (
      uint(selected[0].afterRaw) - uint(selected[0].beforeRaw) !== delta ||
      (a.side === 'Sell' && selected[0].decimals !== decimals) ||
      (a.side === 'Buy'
        ? delta <= 0n || delta < uint(order.minimumOutAmount)
        : delta !== -uint(raw))
    )
      return fail('Simulation token changes differ from the exact action.');
    const wrappedDelta = wrapped.reduce((sum, t) => {
      const change = signed(t.changeRaw);
      if (uint(t.afterRaw) - uint(t.beforeRaw) !== change)
        return fail('Wrapped SOL balance evidence differs.');
      return sum + change;
    }, 0n);
    if (simulation.nativeChangeRaw === null)
      return fail('Native balance evidence is unavailable.');
    const change = signed(simulation.nativeChangeRaw) + wrappedDelta;
    if (a.side === 'Buy' && (change > 0n || -change > uint(raw) + feeBound))
      return fail('Simulated native spending exceeds the approved budget.');
    if (a.side === 'Sell' && change < uint(order.minimumOutAmount) - feeBound)
      return fail(
        'Simulated native output falls below the review budget bound.',
      );
    await current();
    if (Date.parse(order.expiresAt) <= now())
      return fail(
        'Provider order expired. Recover the same preparation request.',
      );
    const summary = warmupPreparationSummary(
      order,
      simulation,
      a.mint,
      inventory,
      buyLink,
    );
    summary.limitations =
      'Unsigned session packet retained privately for exact recovery. Simulation and provisional fee/rent bounds are not instruction, custody or signing qualification. No signing, submission or automatic execution is enabled.';
    return { summary, transaction: order.preparation.transaction };
  };
}
