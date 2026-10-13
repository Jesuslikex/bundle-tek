import { env } from 'cloudflare:workers';
import { decodeTradeSession } from './imported-trade-session';
import {
  captureTradeSession,
  currentTradeSession,
} from './imported-trade-session-server';
import { observeImportedSwapBalance } from './imported-swap-balance';
import { prepareSolanaSwap } from './warmup-swap-quote';
import { simulateImportedSwap } from './imported-swap-simulation';
import {
  saveSwapPreparation,
  swapPreparationSummary,
} from './imported-swap-preparation-history';
import { reserveImportedApproval } from './imported-swap-approval';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from './warmup-signing';
import { createJitoBundle } from './jito-bundle-server';
import type { ImportedTokenDocument } from './imported-token-project';
import { jitoTipLamports } from './jito-bundle';
export async function prepareJitoBundle(
  db: D1Database,
  owner: string,
  input: {
    projectId: string;
    sessionId: string;
    sessionRevision: number;
    entries: number[];
    tipLamports: string;
  },
  signal: AbortSignal,
) {
  jitoTipLamports(input.tipLamports);
  if (
    !Array.isArray(input.entries) ||
    input.entries.length < 1 ||
    input.entries.length > 4 ||
    new Set(input.entries).size !== input.entries.length ||
    input.entries.some((n) => !Number.isInteger(n) || n < 1 || n > 25)
  )
    throw new Error('Choose one to four distinct session entries.');
  const project = await db
    .prepare(
      "SELECT revision,document FROM imported_token_projects WHERE owner_id=? AND id=? AND chain='Solana' AND archived=0",
    )
    .bind(owner, input.projectId)
    .first<{ revision: number; document: string }>();
  const row = await db
    .prepare(
      "SELECT id,revision,state,document,created_at AS createdAt,updated_at AS updatedAt FROM imported_trade_sessions WHERE owner_id=? AND id=? AND project_id=? AND revision=? AND state='active'",
    )
    .bind(owner, input.sessionId, input.projectId, input.sessionRevision)
    .first<{
      id: string;
      revision: number;
      state: 'active';
      document: string;
      createdAt: string;
      updatedAt: string;
    }>();
  if (!row || !project)
    throw new Error('Choose a current active project and session.');
  const session = decodeTradeSession({
    ...row,
    terms: JSON.parse(row.document),
  });
  const token = (JSON.parse(project.document) as ImportedTokenDocument).token;
  if (
    session.terms.projectRevision !== project.revision ||
    session.terms.mint !== token.address ||
    session.terms.decimals !== token.decimals
  )
    throw new Error('Bundle project identity differs.');
  const key = (env as unknown as { JUPITER_API_KEY?: string }).JUPITER_API_KEY;
  if (!key) throw new Error('Bundle quote provider is unavailable.');
  const retained = await db
    .prepare(
      'SELECT count(*) AS count FROM imported_swap_preparations WHERE owner_id=? AND project_id=?',
    )
    .bind(owner, input.projectId)
    .first<{ count: number }>();
  if (!retained || retained.count + input.entries.length > 200)
    throw new Error('Bundle preparation history capacity exceeded.');
  const selected = input.entries
    .toSorted((a, b) => a - b)
    .map((n) => {
      const entry = session.terms.entries.find((e) => e.entry === n);
      if (!entry) throw new Error('Bundle entry unavailable.');
      return entry;
    });
  const created: string[] = [];
  // A single bounded group review shares the existing read gate. Parallel preparation
  // preserves short quote validity without relaxing per-wallet checks or signatures.
  const results = await Promise.allSettled(
    selected.map(async (entry) => {
      const context = {
        projectId: input.projectId,
        projectRevision: project.revision,
        wallet: entry.wallet,
        walletRevision: entry.walletRevision,
        side: session.terms.side,
        unitsRaw: entry.unitsRaw,
        mint: token.address,
        decimals: token.decimals,
      };
      const guard = await captureTradeSession(
        db,
        owner,
        {
          sessionId: session.id,
          revision: session.revision,
          entry: entry.entry,
        },
        context,
      );
      const wallet = await db
        .prepare(
          "SELECT address FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0",
        )
        .bind(owner, entry.wallet, entry.walletRevision)
        .first();
      const occupied = await db
        .prepare(
          'SELECT intent_id FROM solana_swap_reservations WHERE owner_id=? AND wallet_address=?',
        )
        .bind(owner, entry.wallet)
        .first();
      if (!wallet || occupied)
        throw new Error(
          'Choose current unreserved wallets. Recover their existing approvals first.',
        );
      const balance = await observeImportedSwapBalance(
        token,
        entry.wallet,
        session.terms.side,
        entry.amount,
        signal,
      );
      if (
        !balance.amountCovered ||
        !balance.preparationSupported ||
        Date.parse(balance.expiresAt) <= Date.now()
      )
        throw new Error(
          'Bundle wallet balance does not cover a supported preparation.',
        );
      const order = await prepareSolanaSwap(
        {
          tokenMint: token.address,
          decimals: token.decimals,
          side: session.terms.side,
          amount: entry.amount,
          wallet: entry.wallet,
        },
        key,
        signal,
      );
      const simulation = await simulateImportedSwap(order, signal, fetch, true);
      const settlement = await requireWarmupSigningReview(order, simulation);
      const freshGuard = await captureTradeSession(
        db,
        owner,
        {
          sessionId: session.id,
          revision: session.revision,
          entry: entry.entry,
        },
        context,
      );
      if (
        freshGuard.document !== guard.document ||
        freshGuard.controlRevision !== guard.controlRevision
      )
        throw new Error('Bundle session changed during preparation.');
      const document = {
        ...swapPreparationSummary(order, simulation, balance),
        session: freshGuard.selection,
      };
      const saved = await saveSwapPreparation(
        db,
        owner,
        context,
        document,
        undefined,
        undefined,
        freshGuard,
      );
      if (!saved)
        throw new Error('Bundle preparation changed or exceeded capacity.');
      const review: WarmupSigningReview = {
        id: crypto.randomUUID(),
        preparationId: saved.id,
        wallet: entry.wallet,
        sha256: order.preparation.sha256,
        network: 'mainnet',
        expiresAt: order.expiresAt,
        maximumFeeLamports: simulation.networkFeeLamports,
        inputRaw: order.inAmount,
        minimumOutputRaw: order.minimumOutAmount,
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        transaction: order.preparation.transaction,
        lastValidBlockHeight: order.preparation.lastValidBlockHeight,
        settlement,
        ...(order.platformFee ? { platformFee: order.platformFee } : {}),
        session: freshGuard.selection,
      };
      const current = await currentTradeSession(db, owner, saved);
      const result = await reserveImportedApproval(
        db,
        owner,
        { id: saved.id, document: JSON.stringify(document) },
        review,
        undefined,
        undefined,
        current,
      );
      if (!result.meta.changes)
        throw new Error('Bundle wallet became reserved during review.');
      created.push(review.id);
      return review.id;
    }),
  );
  try {
    for (const result of results)
      if (result.status === 'rejected') throw result.reason;
    return await createJitoBundle(
      db,
      owner,
      { ...input, intentIds: created },
      signal,
      true,
    );
  } catch (error) {
    // Nothing has been returned for signing. Cancel only approvals made by this request,
    // and never touch an approval attached to a successfully persisted bundle.
    await db.batch(
      created.map((id) =>
        db
          .prepare(
            "UPDATE imported_swap_signing_intents SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature' AND signature IS NULL AND NOT EXISTS(SELECT 1 FROM jito_bundle_packets WHERE owner_id=? AND intent_id=?)",
          )
          .bind(new Date().toISOString(), owner, id, owner, id),
      ),
    );
    throw error;
  }
}
