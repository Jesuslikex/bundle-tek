'use client';
import type {
  AccountLaunchPayments,
  PumpPaymentReason,
} from '@/lib/account-launch-payments';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import styles from './account-launch-payments.module.css';
const reasons: Record<PumpPaymentReason, string> = {
  'receipt-unobserved': 'No finalized receipt is saved for this packet.',
  'balance-metadata-missing': 'The saved balance metadata is incomplete.',
  'instruction-metadata-missing':
    'The provider did not include the instruction metadata needed to separate setup funding.',
  'instruction-scope-differs':
    'The saved instruction scope or call depth could not be verified.',
  'native-instruction-unsupported':
    'This packet uses a native instruction this breakdown does not yet support.',
  'setup-funding-unclassified':
    'Some native payments could not be assigned to the expected setup accounts or purchase.',
  'native-flow-unexplained':
    'The recorded native transfers do not fully explain the wallet balance changes.',
  'purchase-effect-differs':
    'The observed token or quote changes differ from the selected purchase scope.',
};
export function AccountLaunchPaymentsPanel({
  value,
}: {
  value: AccountLaunchPayments | undefined;
}) {
  const quote =
    value?.quoteMint === 'So11111111111111111111111111111111111111112'
      ? 'SOL'
      : 'quote tokens';
  return (
    <details className={styles.payments}>
      <summary>Purchase payments</summary>
      {!value ? (
        <p>
          Reload saved evidence to check whether a payment breakdown is
          available.
        </p>
      ) : (
        <>
          <output>
            {value.complete
              ? 'Wallet debits reconciled.'
              : `${value.verifiedPacketCount} of ${value.packets.length} packets have reconciled wallet debits. Missing payments remain unknown.`}
          </output>
          {value.verifiedPacketCount > 0 ? (
            <dl className={styles.amounts}>
              <div>
                <dt>
                  {value.complete
                    ? 'Buy quote debit'
                    : 'Known buy quote subtotal'}
                </dt>
                <dd>
                  {formatNativeBalance(
                    value.purchaseQuoteSubtotalRaw,
                    value.quoteDecimals,
                  )}{' '}
                  {quote}
                </dd>
              </div>
              <div>
                <dt>
                  {value.complete
                    ? 'Account setup funding'
                    : 'Known setup funding subtotal'}
                </dt>
                <dd>
                  {formatNativeBalance(value.accountFundingSubtotalLamports, 9)}{' '}
                  SOL
                </dd>
              </div>
            </dl>
          ) : (
            <p>
              Purchase and setup amounts are unavailable. Missing evidence is
              not counted as zero.
            </p>
          )}
          <p>
            Recorded packet fees:{' '}
            {value.packets.some((p) => p.networkFeeLamports !== null)
              ? `${formatNativeBalance(value.knownNetworkFeeLamports, 9)} SOL${value.packets.some((p) => p.networkFeeLamports === null) ? ' (known subtotal)' : ''}`
              : 'Unavailable'}
            .
          </p>
          <p>
            Buy quote debit includes any venue charges. Setup funding is kept
            separate; its rent or refund treatment is unverified. The Jito tip
            is excluded. No acquisition cost or launch profit is assigned by
            this breakdown.
          </p>
          {value.packets.some((p) =>
            p.wallets.some((w) => w.preTokenBalanceRecovered),
          ) && (
            <p>
              Newly allocated token accounts also use their supported creation
              trace to establish a zero starting token balance.
            </p>
          )}
          <details>
            <summary>Wallet payments and evidence gaps</summary>
            <p>
              Quote asset: <code>{value.quoteMint}</code>. Amounts stay in that
              asset’s units.
            </p>
            {value.packets.map((p) => (
              <section
                className={styles.packet}
                key={p.index}
                aria-label={`Packet ${p.index + 1} payments`}
              >
                <h5>
                  Packet {p.index + 1}
                  {p.outcome === 'failed'
                    ? ' · Failed'
                    : p.outcome === 'not-observed'
                      ? ' · Not observed'
                      : ''}
                </h5>
                {!p.verified ? (
                  <p>{reasons[p.reason!]}</p>
                ) : (
                  p.wallets.map((w) => (
                    <article className={styles.wallet} key={w.wallet}>
                      <code>{w.wallet}</code>
                      <dl className={styles.amounts}>
                        <div>
                          <dt>Tokens received</dt>
                          <dd>{formatNativeBalance(w.acquiredRaw, 6)}</dd>
                        </div>
                        <div>
                          <dt>Buy quote debit</dt>
                          <dd>
                            {formatNativeBalance(
                              w.purchaseQuoteRaw,
                              value.quoteDecimals,
                            )}{' '}
                            {quote}
                          </dd>
                        </div>
                        <div>
                          <dt>Account setup funding paid</dt>
                          <dd>
                            {formatNativeBalance(w.accountFundingLamports, 9)}{' '}
                            SOL
                          </dd>
                        </div>
                        <div>
                          <dt>Network fee paid</dt>
                          <dd>
                            {formatNativeBalance(w.networkFeeLamports, 9)} SOL
                          </dd>
                        </div>
                      </dl>
                    </article>
                  ))
                )}
              </section>
            ))}
          </details>
        </>
      )}
    </details>
  );
}
