'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { TrackedWallet } from '@/lib/tracked-wallet';
import type { TrackedTransaction } from '@/lib/tracked-wallet-transaction';
import {
  formatNativeBalance,
  signedBalanceAmount,
} from '@/lib/wallet-balance-format';

export function TrackedTransactionPanel({
  wallet,
  signature,
  onClose,
  saved = false,
  onSaved,
}: {
  wallet: TrackedWallet;
  signature: string;
  onClose: () => void;
  saved?: boolean;
  onSaved?: () => void;
}) {
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{
    reload: number;
    transaction: TrackedTransaction | null;
    error: string;
    stale: boolean;
  } | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const input = {
      address: wallet.address,
      network: wallet.network,
      signature,
      expectedUpdatedAt: wallet.updatedAt,
    };
    const retained = saved && reload === 0;
    void fetch(
      '/api/tracker/transactions' +
        (retained ? '?' + new URLSearchParams(input) : ''),
      retained
        ? { cache: 'no-store', signal: controller.signal }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
            signal: controller.signal,
          },
    )
      .then(async (response) => {
        const data = (await response.json()) as {
          transaction?: TrackedTransaction;
          error?: string;
          stale?: boolean;
        };
        if (!response.ok)
          throw new Error(data.error || 'Transaction unavailable.');
        if (
          !data.transaction ||
          data.transaction.address !== wallet.address ||
          data.transaction.network !== wallet.network ||
          data.transaction.signature !== signature
        )
          throw new Error(
            'Transaction does not match this wallet and signature.',
          );
        if (!controller.signal.aborted) {
          setResult({
            reload,
            transaction: data.transaction,
            error: '',
            stale: Boolean(data.stale),
          });
          if (!retained) onSaved?.();
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            reload,
            transaction: previous?.transaction ?? null,
            stale: previous?.stale ?? false,
            error:
              error instanceof Error
                ? error.message
                : 'Transaction unavailable.',
          }));
      });
    return () => controller.abort();
  }, [
    wallet.address,
    wallet.network,
    wallet.updatedAt,
    signature,
    reload,
    saved,
    onSaved,
  ]);
  const current = result?.reload === reload ? result : null;
  return (
    <section
      className="wallet-holdings-panel"
      aria-label="Tracked transaction details"
    >
      <div className="wallet-roster-toolbar">
        <h2 ref={heading} tabIndex={-1}>
          Transaction · {wallet.label || 'Tracked wallet'}
        </h2>
        <Button variant="outline" onClick={onClose}>
          Close transaction
        </Button>
      </div>
      <p className="warmup-address">Signature: {signature}</p>
      <p className="source-note">
        {saved && reload === 0
          ? 'Saved provider observation. Opening this record does not refresh the chain.'
          : 'A successful provider read is saved to this wallet’s transaction history.'}
      </p>
      {current?.stale && (
        <p className="source-note">
          Saved before the latest tracker edit or archive change. Refresh
          explicitly to capture the current wallet version.
        </p>
      )}
      <p className="source-note">
        Balance changes describe this transaction, including fees, rent and
        account closure. They do not establish a buy, sell, profit or warmup
        receipt.
      </p>
      {!current ? (
        <output>Reading transaction…</output>
      ) : (
        <>
          {current.error && <p role="alert">{current.error}</p>}
          {current.transaction && (
            <TransactionBalanceDetails transaction={current.transaction} />
          )}
        </>
      )}
      <Button
        variant="outline"
        disabled={!current}
        onClick={() => setReload((r) => r + 1)}
      >
        Refresh transaction
      </Button>
    </section>
  );
}
export function TransactionBalanceDetails({
  transaction: t,
}: {
  transaction: TrackedTransaction;
}) {
  return (
    <>
      <p>
        <strong>
          {t.failed ? 'Failed transaction' : 'Confirmed transaction'}
        </strong>{' '}
        · Solana {t.network} · slot {t.slot} ·{' '}
        {t.blockTime === null
          ? 'Block time unavailable'
          : new Date(t.blockTime * 1000).toLocaleString()}
      </p>
      <p className="warmup-address">Tracked address: {t.address}</p>
      <p>
        Wallet signed: {t.walletSigner ? 'Yes' : 'No'} · Fee:{' '}
        {formatNativeBalance(t.feeRaw, 9)} SOL
      </p>
      <p className="warmup-address">Fee payer: {t.feePayer}</p>
      <p>
        Wallet SOL change:{' '}
        <strong>
          {t.nativeChangeRaw === null
            ? 'Wallet not in native account list'
            : signedBalanceAmount(t.nativeChangeRaw, 9) + ' SOL'}
        </strong>
      </p>
      <p className="source-note">
        The fee is paid by the listed fee payer. Wallet SOL change already
        includes any fee charged to this address.
      </p>
      <h3>Wallet token balance changes</h3>
      {!t.tokensComplete ? (
        <p>
          Token balance metadata is incomplete. Token changes are unavailable.
        </p>
      ) : !t.tokenChanges.length ? (
        <p>
          No token accounts attributed to this wallet in the recorded pre/post
          balances.
        </p>
      ) : (
        <div className="wallet-roster-table">
          <table className="project-table">
            <thead>
              <tr>
                <th>Mint / token program</th>
                <th>Before</th>
                <th>After</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {t.tokenChanges.map((token) => (
                <tr key={`${token.program}/${token.mint}`}>
                  <td>
                    <code>{token.mint}</code>
                    <small>{token.program}</small>
                    <details>
                      <summary>Recorded token accounts</summary>
                      {token.accounts.map((address) => (
                        <p className="warmup-address" key={address}>
                          {address}
                        </p>
                      ))}
                    </details>
                  </td>
                  <td>
                    {formatNativeBalance(token.beforeRaw, token.decimals)}
                  </td>
                  <td>{formatNativeBalance(token.afterRaw, token.decimals)}</td>
                  <td>
                    <strong>
                      {signedBalanceAmount(token.changeRaw, token.decimals)}
                    </strong>
                    <small>
                      {token.decimals} decimals · raw change {token.changeRaw}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details>
        <summary>Invoked programs ({t.programs.length})</summary>
        {t.programs.map((program) => (
          <p className="warmup-address" key={program}>
            {program}
          </p>
        ))}
        {!t.innerInstructionsAvailable && (
          <p>
            Inner instruction records are unavailable. Only top-level programs
            are shown.
          </p>
        )}
      </details>
      <p className="source-note">
        {t.source} · confirmed commitment · read{' '}
        {new Date(t.observedAt).toLocaleString()} · provider observation, not a
        finalized receipt
      </p>
    </>
  );
}
