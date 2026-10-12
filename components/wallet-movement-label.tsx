import type { WalletMovementClassification } from '@/lib/wallet-movement-classification';
import {
  formatNativeBalance,
  signedBalanceAmount,
} from '@/lib/wallet-balance-format';
export function WalletMovementLabel({
  classification,
  changeRaw,
  decimals,
}: {
  classification?: WalletMovementClassification;
  changeRaw: string;
  decimals: number;
}) {
  return (
    <div className="min-w-0 space-y-1 break-words">
      <p>
        <strong>{classification?.kind ?? 'unknown'}</strong> · token change{' '}
        {signedBalanceAmount(changeRaw, decimals)}
        {classification?.protocol && <> · {classification.protocol}</>}
      </p>
      {classification?.quote && (
        <p>
          {classification.quote.scope === 'venue-transfer'
            ? 'Venue quote transfer: '
            : 'Observed opposite leg: '}
          {formatNativeBalance(
            classification.quote.raw,
            classification.quote.decimals,
          )}{' '}
          {classification.quote.asset === 'native-sol' ? (
            'SOL'
          ) : (
            <>
              units of{' '}
              <a
                href={`https://solscan.io/token/${classification.quote.mint}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {classification.quote.mint.slice(0, 8)}…
                {classification.quote.mint.slice(-6)}
              </a>
            </>
          )}
          .
        </p>
      )}
      {classification?.quote?.scope === 'venue-transfer' && (
        <p>
          Venue-level quote. Final wallet{' '}
          {classification.kind === 'buy' ? 'cost is' : 'proceeds are'}{' '}
          unverified.
        </p>
      )}
      <details>
        <summary>Classification evidence</summary>
        <p>
          {classification?.reason ??
            'Earlier saved evidence has no classification. Inspect signatures again to apply the current decoders.'}
        </p>
        {Boolean(classification?.counterpartyAccounts.length) && (
          <>
            <p>
              Counterparty token accounts, without inferred wallet ownership:
            </p>
            <ul>
              {classification!.counterpartyAccounts.map((account) => (
                <li key={account}>
                  <a
                    className="break-all"
                    href={`https://solscan.io/account/${account}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {account}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </div>
  );
}
