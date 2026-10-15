'use client';
import { Button } from '@/components/ui/button';
import type { PumpGroupChainEffects } from '@/lib/pump-group-chain-effects';
import styles from './pump-launch-group-ui.module.css';

function display(raw: string, decimals: number) {
  const negative = raw.startsWith('-'),
    digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, '0');
  if (!decimals) return raw;
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return (
    (negative ? '-' : '') +
    digits.slice(0, -decimals) +
    (fraction ? '.' + fraction : '')
  );
}
function download(report: PumpGroupChainEffects) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `bundle-launch-results-${report.reviewId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
export function PumpGroupChainEffectsPanel({
  report,
  disabled,
  onRead,
}: {
  report: PumpGroupChainEffects | null;
  disabled: boolean;
  onRead: () => void;
}) {
  return (
    <section
      className={styles.panel}
      aria-label="Finalized launch wallet results"
    >
      <h4>What reached each wallet</h4>
      <p>
        Read the exact finalized launch transactions. These are changes caused
        by those transactions, not current balances or P&amp;L. The separate
        Jito tip is excluded.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={onRead}
      >
        Read finalized wallet results
      </Button>
      {report && (
        <>
          <output>
            {report.complete
              ? 'Receipt balance coverage complete.'
              : 'Receipt balance coverage incomplete. Known changes are partial subtotals; missing data is not zero.'}
          </output>
          <p>
            Read{' '}
            <time dateTime={report.observedAt}>
              {new Date(report.observedAt).toLocaleString()}
            </time>
            . Known launch network fees: {display(report.knownNetworkFeeRaw, 9)}{' '}
            SOL, excluding the tip transaction fee.
          </p>
          <details>
            <summary>Packet outcomes and explorer links</summary>
            <ol className={styles.packets}>
              {report.packets.map((p) => (
                <li key={p.index}>
                  Packet {p.index + 1}:{' '}
                  {p.outcome === 'not-observed'
                    ? 'No finalized receipt observed'
                    : p.outcome === 'success'
                      ? 'Finalized success'
                      : 'Finalized failure'}
                  . {p.slot && <>Slot {p.slot}. </>}
                  Fee:{' '}
                  {p.networkFeeRaw === null
                    ? 'unresolved'
                    : display(p.networkFeeRaw, 9) + ' SOL'}
                  . {!p.effectsAvailable && 'Balance metadata unavailable. '}
                  <a
                    href={`https://solscan.io/tx/${p.signature}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View packet {p.index + 1}
                  </a>
                </li>
              ))}
            </ol>
          </details>
          <ol className={styles.packets} aria-label="Launch wallet changes">
            {report.wallets.map((w) => (
              <li key={w.address}>
                <strong>{w.role === 'deployer' ? 'Deployer' : 'Holder'}</strong>{' '}
                <code>{w.address}</code>
                <dl>
                  <dt>{w.complete ? 'SOL change' : 'Known SOL subtotal'}</dt>
                  <dd>
                    {display(w.knownSolDeltaRaw, 9)} SOL, including any launch
                    fees and rent.
                  </dd>
                  <dt>
                    {w.complete
                      ? 'Created-token change'
                      : 'Known created-token subtotal'}
                  </dt>
                  <dd>{display(w.knownTokenDeltaRaw, 6)}</dd>
                  {report.quoteMint !==
                    'So11111111111111111111111111111111111111112' && (
                    <>
                      <dt>
                        {w.complete
                          ? 'Quote-token change'
                          : 'Known quote-token subtotal'}
                      </dt>
                      <dd>
                        {display(w.knownQuoteDeltaRaw, report.quoteDecimals)} in{' '}
                        <code>{report.quoteMint}</code>
                      </dd>
                    </>
                  )}
                  <dt>Saved token target</dt>
                  <dd>
                    {w.targetKind === 'none'
                      ? 'No developer buy requested'
                      : `${w.targetKind === 'minimum' ? 'At least ' : ''}${display(w.targetRaw, 6)}`}
                    .{' '}
                    {w.targetStatus === 'matches'
                      ? 'Observed amount meets the saved token target.'
                      : w.targetStatus === 'differs'
                        ? 'Observed amount differs from the saved token target.'
                        : w.targetStatus === 'unknown'
                          ? 'Incomplete evidence; target comparison unavailable.'
                          : ''}
                  </dd>
                </dl>
              </li>
            ))}
          </ol>
          <p>
            Provider-reported transaction effects do not prove pool state, token
            authorities, Token-2022 withheld fees, gross swap spending,
            transaction order within a slot, bundle atomicity or profit. No
            approval, signature or reservation changes result from this read.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => download(report)}
          >
            Download wallet result evidence
          </Button>
        </>
      )}
    </section>
  );
}
