'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { SupplyHistoryRow } from '@/lib/supply-history';
import type { SupplyMovementEvidence } from '@/lib/supply-movement-evidence';
import { signedBalanceAmount } from '@/lib/wallet-balance-format';
import { walletAddress } from '@/lib/wallet-workspace';
import type { SupplyTokenAccounts } from '@/lib/supply-token-accounts';
import {
  requestSupplyAlertChart,
  validMovementBlockTime,
} from '@/lib/supply-alert-chart-events';
type EvidenceRow = { id: string; document: SupplyMovementEvidence };
export function SupplyMovementEvidencePanel({
  projectId,
  revision,
  row,
  wallet,
}: {
  projectId: string;
  revision: number;
  row: SupplyHistoryRow;
  wallet: string;
}) {
  const [records, setRecords] = useState<EvidenceRow[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [accounts, setAccounts] = useState<SupplyTokenAccounts | null>(null);
  const [chartError, setChartError] = useState('');
  const [indexedAddress, setIndexedAddress] = useState(wallet);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function check(r: EvidenceRow) {
    const d = r?.document;
    walletAddress(d?.indexedAddress ?? wallet, 'Solana');
    if (
      !d ||
      d.observationId !== row.id ||
      d.wallet !== wallet ||
      d.mint !== row.document.snapshot.mint ||
      !Number.isSafeInteger(d.fromSlot) ||
      !Number.isSafeInteger(d.toSlot) ||
      d.toSlot !==
        row.document.snapshot.wallets.find((w) => w.address === wallet)?.slot ||
      d.fromSlot < 0 ||
      d.fromSlot >= d.toSlot ||
      !Number.isSafeInteger(d.anchor) ||
      d.anchor < d.toSlot ||
      !Array.isArray(d.transactions) ||
      d.transactions.length > 5
    )
      throw new Error('Movement evidence context differs.');
    for (const t of d.transactions) {
      requireMovementClassification(t.classification, t.changeRaw);
      if (
        typeof t.signature !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(t.signature) ||
        !Number.isSafeInteger(t.slot) ||
        t.slot <= d.fromSlot ||
        t.slot > d.toSlot ||
        (t.blockTime !== null && !validMovementBlockTime(t.blockTime)) ||
        t.decimals !== row.document.snapshot.decimals ||
        typeof t.changeRaw !== 'string' ||
        !/^(-?[1-9]\d{0,19}|0)$/.test(t.changeRaw) ||
        !/^(0|[1-9]\d{0,19})$/.test(t.beforeRaw) ||
        !/^(0|[1-9]\d{0,19})$/.test(t.afterRaw) ||
        BigInt(t.afterRaw) - BigInt(t.beforeRaw) !== BigInt(t.changeRaw)
      )
        throw new Error('Movement transaction context differs.');
    }
    return r;
  }
  async function run(
    scan = false,
    cursor: string | null = null,
    discover = false,
  ) {
    pending.current?.abort();
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    setError('');
    const terms = { id: projectId, revision, observationId: row.id, wallet };
    try {
      let url = '/api/imported-projects/supply-movements',
        init: RequestInit = { signal: c.signal, cache: 'no-store' };
      if (scan || discover)
        init = {
          ...init,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            discover
              ? { ...terms, mode: 'accounts' }
              : { ...terms, cursor, indexedAddress },
          ),
        };
      else
        url +=
          '?' + new URLSearchParams({ ...terms, revision: String(revision) });
      const response = await fetch(url, init),
        data = (await response.json()) as {
          id: string;
          revision: number;
          observationId: string;
          wallet: string;
          items?: EvidenceRow[];
          item?: EvidenceRow;
          error?: string;
          accounts?: SupplyTokenAccounts;
        };
      if (!response.ok)
        throw new Error(data.error || 'Movement inspection unavailable.');
      if (
        data.id !== projectId ||
        data.revision !== revision ||
        data.observationId !== row.id ||
        data.wallet !== wallet
      )
        throw new Error('Movement response context differs.');
      if (discover) {
        const a = data.accounts;
        if (
          !a ||
          a.wallet !== wallet ||
          a.mint !== row.document.snapshot.mint ||
          a.decimals !== row.document.snapshot.decimals ||
          !Number.isSafeInteger(a.slot) ||
          a.slot <
            row.document.snapshot.wallets.find((w) => w.address === wallet)!
              .slot ||
          !Array.isArray(a.accounts) ||
          a.accounts.length > 500 ||
          new Set(a.accounts).size !== a.accounts.length
        )
          throw new Error('Token account discovery context differs.');
        a.accounts.forEach((address) => walletAddress(address, 'Solana'));
        if (!c.signal.aborted) setAccounts(a);
      } else if (scan) {
        if (!data.item) throw new Error('Missing movement result.');
        const checked = check(data.item);
        if ((checked.document.indexedAddress ?? wallet) !== indexedAddress)
          throw new Error('Movement index context differs.');
        if (!c.signal.aborted)
          setRecords((old) =>
            [checked, ...old.filter((r) => r.id !== checked.id)].slice(0, 20),
          );
      } else {
        if (!Array.isArray(data.items) || data.items.length > 20)
          throw new Error('Invalid movement history.');
        const checked = data.items.map(check);
        if (!c.signal.aborted) setRecords(checked);
      }
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Movement evidence unavailable.',
        );
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  const latest = records.find(
    (r) => (r.document.indexedAddress ?? wallet) === indexedAddress,
  )?.document;
  const indexes = [
    ...new Set([
      wallet,
      ...(accounts?.accounts ?? []),
      ...records.map((r) => r.document.indexedAddress ?? wallet),
    ]),
  ];
  const transactions = [
    ...new Map(
      records
        .toReversed()
        .flatMap((r) =>
          r.document.transactions.map((t) => [t.signature, t] as const),
        ),
    ).values(),
  ];
  return (
    <section
      className="supply-movement-evidence"
      aria-label="Wallet alert transaction evidence"
    >
      <details>
        <summary>Transaction evidence ({transactions.length} decoded)</summary>
        <label>
          Signature index
          <select
            value={indexedAddress}
            disabled={busy}
            onChange={(e) => setIndexedAddress(e.target.value)}
          >
            {indexes.map((address) => (
              <option key={address} value={address}>
                {address === wallet
                  ? 'Wallet address'
                  : `Token account ${address.slice(0, 8)}…${address.slice(-6)}`}
              </option>
            ))}
          </select>
        </label>
        <div className="wallet-roster-actions">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(false, null, true)}
          >
            Find token accounts
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void run()}>
            Load saved transaction evidence
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(true)}
          >
            Inspect alert transactions
          </Button>
          {latest?.nextCursor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run(true, latest.nextCursor)}
            >
              Inspect older signatures
            </Button>
          )}
        </div>
        {accounts && (
          <p>
            {accounts.accounts.length} current token accounts found at finalized
            slot {accounts.slot}. Select an account to inspect its signatures.
          </p>
        )}
        {latest && (
          <p>
            Inspected slots after {latest.fromSlot} through {latest.toSlot} ·
            finalized signature anchor {latest.anchor}. Index:{' '}
            {latest.indexedAddress ?? wallet}.{' '}
            {latest.completeThroughBoundary
              ? 'Address signature boundary reached.'
              : 'More address signatures may remain.'}{' '}
            This page: {latest.unavailableTransactions} unavailable token
            decodes; {latest.failedSignatures} failed signatures omitted.
          </p>
        )}
        {transactions.map((t) => (
          <p key={t.signature}>
            <a
              href={`https://solscan.io/tx/${t.signature}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Transaction {t.signature.slice(0, 10)}…
            </a>{' '}
            · slot {t.slot} · {t.classification?.kind ?? 'unknown'} · token
            change {signedBalanceAmount(t.changeRaw, t.decimals)}
            {t.classification && <span> · {t.classification.reason}</span>}
            {' · '}
            {t.blockTime === null
              ? 'Block time unavailable'
              : new Date(t.blockTime * 1000).toLocaleString()}{' '}
            <Button
              variant="outline"
              disabled={t.blockTime === null}
              aria-label={`Inspect movement transaction on chart ${t.signature}`}
              onClick={() => {
                if (t.blockTime === null) return;
                setChartError(
                  requestSupplyAlertChart({
                    projectId,
                    revision,
                    mint: row.document.snapshot.mint,
                    wallet,
                    from: row.document.previousObservedAt!,
                    to: row.document.snapshot.observedAt,
                    transaction: {
                      signature: t.signature,
                      slot: t.slot,
                      blockTime: t.blockTime,
                    },
                  }) ?? '',
                );
              }}
            >
              Inspect transaction on chart
            </Button>
          </p>
        ))}
        {latest && !transactions.length && (
          <p>
            No matching token change was decoded from these inspected
            signatures.
          </p>
        )}
        <p>
          Inspect the wallet and each discovered token account to broaden
          coverage. Discovery lists current accounts; closed or reassigned
          historical accounts can be missing. Each index has separate pages.
          Decoded changes are deduplicated across indexes and show this
          wallet&apos;s mint-wide balance change in each transaction. This does
          not prove complete activity. Buy/sell labels require a decoded
          wallet-authorized swap and reconciled transfer legs. Transfers require
          matching parsed SPL instructions; unsupported or ambiguous operations
          remain unknown. Counterparty token accounts do not identify their
          wallet owners.
        </p>
        {error && <p role="alert">{error}</p>}
        {chartError && <p role="alert">{chartError}</p>}
      </details>
    </section>
  );
}
import { requireMovementClassification } from '@/lib/wallet-movement-classification';
