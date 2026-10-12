'use client';
import { WithdrawalFailureEvidence } from './withdrawal-failure-evidence';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import type { WithdrawalActivityEvent } from '@/lib/withdrawal-activity';
import { withdrawalActivityLabel } from '@/lib/withdrawal-activity';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
export function WithdrawalActivityRecord({
  event,
  onClose,
  onOpenWallet,
}: {
  event: WithdrawalActivityEvent;
  onClose: () => void;
  onOpenWallet?: (wallet: string) => void;
}) {
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    panel.current?.focus();
  }, [event.sequence]);
  const row = event.withdrawal,
    r = row.document,
    receipt = row.receipt;
  return (
    <section
      className="native-withdrawal-panel withdrawal-activity-record"
      aria-label="Saved withdrawal event"
      ref={panel}
      tabIndex={-1}
    >
      <h2>{withdrawalActivityLabel(row.state)}</h2>
      <p>
        Captured {new Date(event.createdAt).toLocaleString()} · event{' '}
        {event.sequence} · withdrawal {row.id}
      </p>
      <p>
        {r.amount} {r.token ? 'tokens' : 'SOL'} requested from {r.wallet} to{' '}
        {r.recipient}. Wallet revision {r.walletRevision}.
      </p>
      {r.token && (
        <p>
          Mint {r.token.mint} · {r.token.decimals} decimals · program{' '}
          {r.token.program} · source account {r.token.sourceAccount} ·
          destination account {r.token.destinationAccount}
        </p>
      )}
      {r.token?.transferFee && (
        <p>
          Reviewed token fee{' '}
          {formatNativeBalance(r.token.transferFee.feeRaw, r.token.decimals)}{' '}
          tokens · recipient net{' '}
          {formatNativeBalance(
            r.token.transferFee.netAmountRaw,
            r.token.decimals,
          )}{' '}
          tokens · epoch {r.token.transferFee.epoch}
        </p>
      )}
      <p>
        Maximum SOL debit {formatNativeBalance(r.maximumDebitRaw, 9)} SOL ·
        network fee limit {formatNativeBalance(r.feeLamports, 9)} SOL · retained
        reserve {formatNativeBalance(r.reserveLamports, 9)} SOL
      </p>
      <p>
        Review expires {new Date(r.expiresAt).toLocaleString()} · packet hash{' '}
        {r.sha256}
      </p>
      {row.signature && (
        <p>
          Registered signature {row.signature}.{' '}
          <a
            href={
              'https://explorer.solana.com/tx/' +
              encodeURIComponent(row.signature)
            }
            target="_blank"
            rel="noreferrer"
          >
            View transaction
          </a>
        </p>
      )}
      {receipt ? (
        <p>
          Verified finalized slot {receipt.slot} · actual network fee{' '}
          {formatNativeBalance(receipt.networkFeeLamports, 9)} SOL · recipient
          received{' '}
          {formatNativeBalance(
            receipt.token?.destinationChangeRaw ?? receipt.recipientChangeRaw,
            receipt.token?.decimals ?? 9,
          )}{' '}
          {receipt.token ? 'tokens' : 'SOL'}
          {receipt.token && (
            <>
              {' '}
              · actual account rent{' '}
              {formatNativeBalance(receipt.token.accountRentLamports, 9)} SOL ·
              token fee{' '}
              {formatNativeBalance(
                receipt.token.transferFeeRaw ?? '0',
                receipt.token.decimals,
              )}{' '}
              tokens
            </>
          )}
        </p>
      ) : row.state === 'failed' ? (
        <WithdrawalFailureEvidence receipt={row.failureReceipt} />
      ) : (
        <p>
          No successful finalized transfer receipt was recorded at this
          transition. Signing and submission records do not prove delivery.
          Later records may show an outcome.
        </p>
      )}
      <Button variant="outline" onClick={onClose}>
        Close withdrawal record
      </Button>
      {onOpenWallet && (
        <Button variant="outline" onClick={() => onOpenWallet(r.wallet)}>
          Open wallet withdrawal history
        </Button>
      )}
    </section>
  );
}
