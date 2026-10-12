'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type {
  FundingExecutionHistory,
  FundingReceipt,
} from '@/lib/funding-execution-history';

function transactionUrl(signature: string) {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}
function Receipt({ receipt }: { receipt: FundingReceipt }) {
  return (
    <article className="wallet-audit">
      <strong>
        {receipt.outcome === 'failed'
          ? 'Failed. Amount not delivered.'
          : 'Finalized transfer verified.'}
      </strong>
      <p>
        {receipt.amount} {receipt.mint ? 'SPL tokens' : 'SOL'}
        {receipt.outcome === 'failed' ? ' requested' : ' delivered'} · approval
        revision {receipt.fundingRevision}
      </p>
      <p className="warmup-address">Recipient: {receipt.recipient}</p>
      <details>
        <summary>Receipt details</summary>
        <p className="warmup-address">Funder: {receipt.wallet}</p>
        {receipt.mint && (
          <p className="warmup-address">
            Mint: {receipt.mint} · {receipt.decimals} decimals
          </p>
        )}
        <p>
          Finalized slot {receipt.slot}. Verified{' '}
          {new Date(receipt.verifiedAt).toLocaleString()}.
        </p>
        <p>
          Network fee:{' '}
          {receipt.feeLamports === null
            ? 'not retained in this receipt'
            : `${receipt.feeLamports} lamports`}
          .
        </p>
        {receipt.transactionError && (
          <p className="warmup-address">
            Transaction error: {receipt.transactionError}
          </p>
        )}
      </details>
      <a
        href={transactionUrl(receipt.signature)}
        target="_blank"
        rel="noopener noreferrer"
      >
        View finalized devnet transaction
      </a>
    </article>
  );
}
export function FundingHistoryContent({
  data,
}: {
  data: FundingExecutionHistory;
}) {
  return (
    <>
      {data.archived && (
        <p>Archived draft. Retained receipts remain available.</p>
      )}
      {data.pending.length > 0 && (
        <div aria-label="Unresolved funding attempts">
          <h4>Pending funding work</h4>
          <p>
            Connect the listed funder in the devnet tools to inspect and recover
            its pending operation. A signature alone does not prove broadcast or
            delivery.
          </p>
          {data.pending.map((op) => (
            <article className="wallet-audit" key={op.id}>
              <strong>
                {op.state === 'preparing'
                  ? 'Prepared reservation. Approval has not begun.'
                  : op.state === 'submitted'
                    ? 'Signature recorded. Broadcast outcome unverified.'
                    : 'Approval outcome unresolved.'}
              </strong>
              <p>
                {op.amount} {op.mint ? 'SPL tokens' : 'SOL'} requested ·
                approval revision {op.fundingRevision}
              </p>
              <p className="warmup-address">Funder: {op.wallet}</p>
              <p className="warmup-address">Recipient: {op.recipient}</p>
              {op.mint && <p className="warmup-address">Mint: {op.mint}</p>}
              <p className="warmup-address">Operation: {op.id}</p>
              {op.signature && (
                <a
                  href={transactionUrl(op.signature)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Inspect recorded devnet signature
                </a>
              )}
            </article>
          ))}
          {data.pendingTruncated && (
            <p>
              Showing the latest 50 pending attempts. Use the connected wallet
              journal for each funder.
            </p>
          )}
        </div>
      )}
      <h4>Verified receipts</h4>
      <p>
        Saved devnet evidence across this draft&apos;s revisions and funders.
        These are historical attempts; changing an allocation does not change an
        earlier receipt.
      </p>
      {data.receipts.length === 0 ? (
        <p>No verified funding receipts for this draft.</p>
      ) : (
        data.receipts.map((receipt) => (
          <Receipt key={receipt.id} receipt={receipt} />
        ))
      )}
    </>
  );
}
export function FundingExecutionHistoryPanel({
  id,
  revision,
  name,
  externalRevision = 0,
}: {
  id: string;
  revision: number;
  name: string;
  externalRevision?: number;
}) {
  const [reload, setReload] = useState(0);
  const identity = `${id}/${revision}/${externalRevision}/${reload}`;
  const [state, setState] = useState<{
    identity: string;
    data: FundingExecutionHistory | null;
    error: string;
    loading: boolean;
  }>({ identity: '', data: null, error: '', loading: true });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    void (async () => {
      try {
        const response = await fetch(
          `/api/funding/history?id=${encodeURIComponent(id)}&revision=${revision}`,
          { cache: 'no-store', signal: active.signal },
        );
        const data = (await response.json()) as FundingExecutionHistory & {
          error?: string;
        };
        if (
          !response.ok ||
          data.id !== id ||
          data.revision !== revision ||
          !Array.isArray(data.receipts) ||
          !Array.isArray(data.pending) ||
          !(data.nextCursor === null || typeof data.nextCursor === 'string')
        )
          throw new Error(data.error || 'Funding history revision mismatch.');
        if (!active.signal.aborted)
          setState({ identity, data, error: '', loading: false });
      } catch (err) {
        if (!active.signal.aborted)
          setState({
            identity,
            data: null,
            error:
              err instanceof Error
                ? err.message
                : 'Funding history unavailable.',
            loading: false,
          });
      }
    })();
    return () => active.abort();
  }, [id, revision, identity]);
  const current = state.identity === identity;
  const data = current ? state.data : null;
  const loading = !current || state.loading;
  async function older() {
    const active = controller.current,
      cursor = data?.nextCursor;
    if (
      !active ||
      active.signal.aborted ||
      !cursor ||
      loading ||
      !data ||
      data.receipts.length >= 1000
    )
      return;
    setState((value) => ({ ...value, loading: true, error: '' }));
    try {
      const response = await fetch(
        `/api/funding/history?id=${encodeURIComponent(id)}&revision=${revision}&cursor=${encodeURIComponent(cursor)}`,
        { cache: 'no-store', signal: active.signal },
      );
      const page = (await response.json()) as FundingExecutionHistory & {
        error?: string;
      };
      if (
        !response.ok ||
        page.id !== id ||
        page.revision !== revision ||
        !Array.isArray(page.receipts) ||
        !Array.isArray(page.pending) ||
        !(page.nextCursor === null || typeof page.nextCursor === 'string') ||
        page.nextCursor === cursor
      )
        throw new Error(page.error || 'Funding history page mismatch.');
      if (!active.signal.aborted)
        setState((value) => ({
          identity,
          loading: false,
          error: '',
          data: {
            ...page,
            receipts: [
              ...value.data!.receipts,
              ...page.receipts.filter(
                (row) => !value.data!.receipts.some((old) => old.id === row.id),
              ),
            ],
          },
        }));
    } catch (err) {
      if (!active.signal.aborted)
        setState((value) => ({
          ...value,
          loading: false,
          error:
            err instanceof Error ? err.message : 'Older receipts unavailable.',
        }));
    }
  }
  return (
    <section
      className="wallet-holdings-panel"
      aria-label="Saved funding execution history"
    >
      <h3>Funding execution history</h3>
      <p>
        {name} · saved revision {revision} · Solana devnet
      </p>
      <Button
        variant="outline"
        disabled={loading}
        onClick={() => setReload((value) => value + 1)}
      >
        Refresh execution history
      </Button>
      {loading && <output>Loading funding execution history…</output>}
      {current && state.error && <p role="alert">{state.error}</p>}
      {data && <FundingHistoryContent data={data} />}
      {data?.nextCursor && (
        <Button
          variant="outline"
          disabled={loading || data.receipts.length >= 1000}
          onClick={() => void older()}
        >
          Load older funding receipts
        </Button>
      )}
      {data?.nextCursor && data.receipts.length >= 1000 && (
        <p>
          Showing 1,000 receipts. Use account Activity to review additional
          history.
        </p>
      )}
    </section>
  );
}
