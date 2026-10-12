'use client';
import { ImportedAcquisitionReview } from './imported-acquisition-review';
import {
  validatedImportedAcquisitionSelection,
  type ImportedAcquisitionSelection,
} from '@/lib/imported-acquisition';
import { WarmupSigningRecovery } from './warmup-signing-recovery';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { SavedSwapPreparation } from '@/lib/imported-swap-preparation-history';
import type { unsignedPreparationSummary } from '@/lib/imported-swap-preparation-history';
import type { SavedWarmupPreparation } from '@/lib/warmup-preparation-history';
type ReviewRecord = Omit<SavedSwapPreparation, 'document'> & {
  cycle?: number;
  document: ReturnType<typeof unsignedPreparationSummary> & {
    acquisition?: ImportedAcquisitionSelection;
    conditional?: SavedSwapPreparation['document']['conditional'];
    balance?: SavedSwapPreparation['document']['balance'];
    inventory?: SavedWarmupPreparation['document']['inventory'];
    buyReceipt?: SavedWarmupPreparation['document']['buyReceipt'];
  };
};
export function ImportedPreparationHistory({
  id,
  revision,
  scope = 'project',
}: {
  id: string;
  revision: number;
  scope?: 'project' | 'warmup';
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label={
        scope === 'warmup'
          ? 'Warmup swap preparation history'
          : 'Imported swap preparation history'
      }
    >
      <Button variant="outline" onClick={() => setOpen((value) => !value)}>
        {open ? 'Close preparation history' : 'Open preparation history'}
        {scope === 'warmup' ? ' for warmup' : ''}
      </Button>
      {open && (
        <PreparationHistory
          key={id}
          id={id}
          revision={revision}
          scope={scope}
        />
      )}
    </section>
  );
}
function PreparationHistory({
  id,
  revision,
  scope,
}: {
  id: string;
  revision: number;
  scope: 'project' | 'warmup';
}) {
  const [rows, setRows] = useState<ReviewRecord[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const read = useCallback(
    async (after: string | null) => {
      pending.current?.abort();
      const c = new AbortController();
      pending.current = c;
      setBusy(true);
      try {
        const response = await fetch(
          `${scope === 'warmup' ? '/api/wallet-workspace/warmup' : '/api/imported-projects'}/preparations?id=${encodeURIComponent(id)}${after ? `&cursor=${encodeURIComponent(after)}` : ''}`,
          {
            cache: 'no-store',
            signal: AbortSignal.any([c.signal, AbortSignal.timeout(10000)]),
          },
        );
        const data = (await response.json()) as {
          projectId: string;
          planId?: string;
          executionAllowed: boolean;
          preparations: Array<ReviewRecord & Partial<SavedWarmupPreparation>>;
          nextCursor: string | null;
          error?: string;
        };
        if (
          !response.ok ||
          (scope === 'warmup' ? data.planId : data.projectId) !== id ||
          data.executionAllowed !== false ||
          !Array.isArray(data.preparations) ||
          data.preparations.some(
            (row) =>
              (scope === 'warmup' ? row.planId : row.projectId) !== id ||
              row.document.executionAllowed !== false ||
              row.document.instructionsVerified !== false,
          )
        )
          throw new Error(data.error || 'Preparation history unavailable.');
        for (const row of data.preparations)
          if (row.document.acquisition) {
            if (scope !== 'project' || row.document.side !== 'Sell')
              throw new Error('Acquisition context differs.');
            validatedImportedAcquisitionSelection(row.document.acquisition, {
              projectId: id,
              wallet: row.document.wallet,
              mint: row.document.inputMint,
              unitsRaw: row.document.inAmountRaw,
            });
          }
        const records: ReviewRecord[] = data.preparations.map((row) =>
          scope === 'warmup'
            ? {
                ...row,
                projectId: row.planId!,
                projectRevision: row.planRevision!,
              }
            : row,
        );
        if (!c.signal.aborted && pending.current === c) {
          setRows((previous) =>
            after
              ? [
                  ...previous,
                  ...records.filter(
                    (row) => !previous.some((old) => old.id === row.id),
                  ),
                ]
              : records,
          );
          setCursor(data.nextCursor);
          setError('');
        }
      } catch (e) {
        if (!c.signal.aborted && pending.current === c)
          setError(
            e instanceof Error ? e.message : 'Preparation history unavailable.',
          );
      } finally {
        if (pending.current === c) setBusy(false);
      }
    },
    [id, scope],
  );
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => {
      if (current) return read(null);
    });
    return () => {
      current = false;
      pending.current?.abort();
      pending.current = null;
    };
  }, [read, revision]);
  return (
    <section aria-label="Saved unsigned swap preparations">
      <h4>Preparation history</h4>
      <p>
        Saved server preparation summaries across{' '}
        {scope === 'warmup' ? 'plan' : 'project'} and wallet revisions,
        including archives. Up to 200 records per{' '}
        {scope === 'warmup' ? 'plan' : 'project'}. These are unsigned reviews,
        not executed trades or receipts. Raw transaction packets are not
        retained. Use a fresh preparation for any future approval.
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void read(null)}>
        {busy ? 'Loading preparation history…' : 'Reload preparation history'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {rows.map((row) => (
        <PreparationHistoryRecord
          key={row.id}
          record={row}
          projectRevision={revision}
          contextLabel={scope === 'warmup' ? 'plan' : 'project'}
        />
      ))}
      {!busy && rows.length === 0 && <p>No saved swap preparations.</p>}
      {cursor && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void read(cursor)}
        >
          Older preparations
        </Button>
      )}
    </section>
  );
}
export function PreparationHistoryRecord({
  record: row,
  projectRevision,
  contextLabel = 'project',
}: {
  record: ReviewRecord;
  projectRevision: number;
  contextLabel?: 'project' | 'plan';
}) {
  const value = row.document;
  return (
    <article>
      <strong>
        Unsigned {value.side.toLowerCase()} ·{' '}
        {value.simulation.succeeded
          ? 'Simulation completed'
          : 'Simulation failed'}
      </strong>
      <p>
        {new Date(row.createdAt).toLocaleString()} · {contextLabel} r
        {row.projectRevision} · wallet r{row.walletRevision}
        {row.cycle ? ` · cycle ${row.cycle}` : ''}
      </p>
      {row.projectRevision !== projectRevision && (
        <p>
          Captured under an older {contextLabel} revision. Retained for history.
        </p>
      )}
      <p className="warmup-address">
        Wallet: {value.wallet}
        <br />
        Transaction fingerprint: {value.transaction.sha256}
      </p>
      <p>
        Input: {value.inAmountRaw} atomic units. Quoted output:{' '}
        {value.quotedOutRaw}. Minimum output: {value.minimumOutRaw}.
      </p>
      {value.conditional && (
        <section aria-label="Captured conditional order">
          <p>
            Conditional order {value.conditional.orderId}, revision{' '}
            {value.conditional.orderRevision}, level {value.conditional.level}.
            Saved target: ${value.conditional.targetUsd},{' '}
            {value.conditional.direction === 'at-or-above'
              ? 'at or above'
              : 'at or below'}
            .
          </p>
          <p>
            Captured market-cap estimate $
            {value.conditional.observedMarketCapUsd} at{' '}
            {value.conditional.observedAt}. Observation expiry:{' '}
            {value.conditional.expiresAt}. Historical condition evidence does
            not approve execution.
          </p>
          <p className="warmup-address">
            Pool: {value.conditional.pair}. Terms fingerprint:{' '}
            {value.conditional.termsSha256}.
          </p>
        </section>
      )}
      <p>
        Original order expiry: {new Date(value.expiresAt).toLocaleString()}.
        Saved history grants no signing or execution clearance.
      </p>
      <details>
        <summary>Review saved preparation summary</summary>
        <p className="warmup-address">
          Input mint: {value.inputMint}
          <br />
          Output mint: {value.outputMint}
        </p>
        <p>
          {value.router} · {value.quoteSource} · {value.slippageBps} bps
          slippage. Quote observed {value.quotedAt}.
        </p>
        <p>
          {value.transaction.bytes} bytes · {value.transaction.instructionCount}{' '}
          instructions · {value.transaction.lookupTableCount} lookup tables.
          Estimated fees: {value.transaction.estimatedFeesLamports} lamports.
        </p>
        {value.balance && (
          <p>
            Balance source: {value.balance.source} · observed{' '}
            {value.balance.observedAt} · slot {value.balance.nativeSlot}.
            Covered input at preparation:{' '}
            {value.balance.amountCovered ? 'yes' : 'no'}.
          </p>
        )}
        {value.inventory && (
          <p>
            Sell inventory: {value.inventory.unfrozenRaw} unfrozen atomic units
            · input {value.inventory.requestedRaw} · observed{' '}
            {value.inventory.observedAt} · {value.inventory.source} · slots{' '}
            {value.inventory.minSlot} to {value.inventory.maxSlot}.{' '}
            {value.inventory.limitations}
          </p>
        )}
        {value.buyReceipt && (
          <p>
            Matching buy receipt: {value.buyReceipt.signature} · acquired{' '}
            {value.buyReceipt.acquiredRaw} atomic units · finalized slot{' '}
            {value.buyReceipt.slot}. {value.buyReceipt.limitations}
          </p>
        )}
        <p>
          Simulation: {value.simulation.source} · observed{' '}
          {value.simulation.observedAt} · fee slot {value.simulation.feeSlot} ·
          simulation slot {value.simulation.simulationSlot}.
        </p>
        <p>
          RPC network fee: {value.simulation.networkFeeLamports} lamports.
          Simulated native change:{' '}
          {value.simulation.nativeChangeRaw ?? 'unavailable'} lamports. Compute
          units: {value.simulation.unitsConsumed ?? 'unavailable'}.
        </p>
        <p>
          Route fields: {value.simulation.routeStatus}. Token account bindings:{' '}
          {value.simulation.bindingStatus}. Authority actions:{' '}
          {value.simulation.authorityActionCount ?? 'unavailable'}.
        </p>
        <p>
          Simulated input amount comparison:{' '}
          {value.simulation.inputAmountMatches === null
            ? 'unavailable'
            : value.simulation.inputAmountMatches
              ? 'matches'
              : 'mismatch'}
          . Simulated minimum output:{' '}
          {value.simulation.minimumOutputCovered === null
            ? 'unavailable'
            : value.simulation.minimumOutputCovered
              ? 'covered'
              : 'not covered'}
          . Token metadata complete:{' '}
          {value.simulation.tokensComplete ? 'yes' : 'no'}.
        </p>
        <p>
          Unrecognized instructions:{' '}
          {value.simulation.unrecognizedInstructionCount ?? 'unavailable'}.
          Unresolved accounts:{' '}
          {value.simulation.unresolvedAccountCount ?? 'unavailable'}.
        </p>
        {value.acquisition && (
          <ImportedAcquisitionReview acquisition={value.acquisition} />
        )}
        <p>{value.limitations}</p>
        {contextLabel === 'plan' && (
          <WarmupSigningRecovery preparationId={row.id} />
        )}
      </details>
    </article>
  );
}
