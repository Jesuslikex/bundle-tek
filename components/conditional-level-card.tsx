'use client';
import { Button } from './ui/button';
import type { ConditionalSellOrder } from '@/lib/conditional-sell-order';
import type { ConditionalLevelStatus } from '@/lib/conditional-level-status';

export function ConditionalLevelCard({
  order,
  level,
  status,
  symbol,
  busy,
  canPrepare,
  onPrepare,
  onRecover,
}: {
  order: ConditionalSellOrder;
  level: ConditionalSellOrder['terms']['levels'][number];
  status?: ConditionalLevelStatus;
  symbol: string;
  busy: boolean;
  canPrepare: boolean;
  onPrepare: () => void;
  onRecover: () => void;
}) {
  const label = status
    ? {
        filled: 'Filled',
        awaiting_signature: 'Waiting for signature',
        signed: 'Signed',
        submitted: 'Submitted',
      }[status.state]
    : order.state === 'cancelled'
      ? 'Cancelled'
      : 'Available for review';
  return (
    <li
      className="conditional-level-card"
      data-state={status?.state ?? order.state}
      aria-label={`Conditional level ${level.level}`}
    >
      <div className="conditional-level-card__heading">
        <strong>Level {level.level}</strong>
        <span className="conditional-level-card__status">{label}</span>
      </div>
      <div className="conditional-level-card__target">
        <span>Market cap target</span>
        <strong>${level.targetUsd}</strong>
        <span>
          {order.terms.direction === 'at-or-above'
            ? 'At or above'
            : 'At or below'}
        </span>
      </div>
      <p>
        Sell{' '}
        <strong>
          {level.amount} {symbol}
        </strong>
      </p>
      {order.state === 'draft' && (
        <Button
          type="button"
          variant="outline"
          disabled={!canPrepare}
          onClick={onPrepare}
        >
          Prepare level {level.level}
        </Button>
      )}
      {status && (
        <>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onRecover}
          >
            Open level {level.level} approval recovery
          </Button>
          <details>
            <summary>Approval and receipt details</summary>
            <p>
              Approval <code>{status.intentId}</code>
            </p>
            {status.signature && (
              <p>
                Signature <code>{status.signature}</code>
              </p>
            )}
            {status.receiptId && (
              <p>
                Receipt <code>{status.receiptId}</code>
              </p>
            )}
          </details>
        </>
      )}
    </li>
  );
}
