'use client';
import { useState } from 'react';
import { usePairMarketSelection } from './pair-market-selection';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { chainQuoteAssets } from '@/lib/quote-catalog';
import type { PairOrderFirstRequest } from '@/lib/pair-order-first-service';
import { ImportedPairOrderReview } from './imported-pair-order-review';
import styles from './imported-pair-order-review.module.css';

/** Own trade-wallet panel: no token layout or shared quote-state changes. */
export function ImportedPairTradeWalletReview({
  project,
  wallet,
  side,
  locked,
}: {
  project: ImportedTokenProject;
  wallet: WorkspaceWallet;
  side: 'Buy' | 'Sell';
  locked: boolean;
}) {
  const marketPair = usePairMarketSelection(project.id, project.revision);
  const [quoteMint, setQuoteMint] = useState(''),
    [amount, setAmount] = useState(''),
    [allowance, setAllowance] = useState(''),
    [absolute, setAbsolute] = useState('');
  const assets = chainQuoteAssets('Solana').filter(
    (a) => a.address !== project.document.token.address,
  );
  const asset = assets.find((a) => a.address === quoteMint);
  const validAmount =
    /^\d{1,20}(?:\.\d{1,255})?$/.test(amount) && Number(amount) > 0;
  const uint = (v: string) =>
    /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= (1n << 64n) - 1n;
  const ready =
    !!asset && validAmount && uint(allowance) && (!absolute || uint(absolute));
  const request: PairOrderFirstRequest | null = ready
    ? {
        id: project.id,
        revision: project.revision,
        wallet: wallet.address,
        walletRevision: wallet.revision,
        side,
        amount,
        quoteMint,
        feeAndRentLimitRaw: allowance,
        absoluteMinimumRaw: absolute || null,
        marketPair,
        prepareUnsigned: true,
      }
    : null;
  return (
    <details className={styles.panel}>
      <summary>Stock and custom pair review</summary>
      <p>
        Review {side.toLowerCase()} against an exact catalog asset. Amounts here
        are separate from the SOL trade form. Signing is disabled.
      </p>
      <p>
        Independent comparison market pair:{' '}
        {marketPair ??
          'No market pair is available for this review. The independent comparison is unavailable.'}
      </p>
      <label>
        Pair asset
        <select
          value={quoteMint}
          disabled={locked}
          onChange={(e) => setQuoteMint(e.target.value)}
        >
          <option value="">Choose the exact quote asset</option>
          {assets.map((a) => (
            <option key={a.address} value={a.address}>
              {a.symbol} · {a.address}
            </option>
          ))}
        </select>
      </label>
      <label>
        {side === 'Buy'
          ? `Spend ${asset?.symbol ?? 'pair asset'}`
          : `Sell ${project.document.token.symbol}`}
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          disabled={locked}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label>
        Maximum fee and rent allowance (lamports)
        <input
          type="text"
          inputMode="numeric"
          value={allowance}
          disabled={locked}
          onChange={(e) => setAllowance(e.target.value)}
        />
      </label>
      <label>
        Absolute minimum output (atomic units, optional)
        <input
          type="text"
          inputMode="numeric"
          value={absolute}
          disabled={locked}
          onChange={(e) => setAbsolute(e.target.value)}
        />
      </label>
      {asset && (
        <p>
          Pair asset mint: {asset.address}. Catalog membership does not verify
          the issuer or eligibility to trade.
        </p>
      )}
      <ImportedPairOrderReview
        request={request}
        locked={locked || project.archived || wallet.archived}
      />
    </details>
  );
}
