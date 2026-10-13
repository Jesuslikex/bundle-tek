'use client';
import { useMemo, useState } from 'react';
import { conditionalTriggerQueue } from '@/lib/conditional-trigger-queue';
import { conditionalOrderSide } from '@/lib/conditional-order';
import { Button } from './ui/button';

type Input = Parameters<typeof conditionalTriggerQueue>[0];
export function ConditionalTriggerQueue({
  input,
  busy,
  onReview,
}: {
  input: Input;
  busy: boolean;
  onReview: (
    candidate: ReturnType<typeof conditionalTriggerQueue>['candidates'][number],
  ) => void;
}) {
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const { orders, statuses, wallets, project, pair, observation, now } = input;
  const result = useMemo(() => {
    try {
      return {
        value: conditionalTriggerQueue({
          orders,
          statuses,
          wallets,
          project,
          pair,
          observation,
          now,
        }),
        error: null,
      };
    } catch (failure) {
      return {
        value: null,
        error:
          failure instanceof Error
            ? failure.message
            : 'Trigger queue unavailable.',
      };
    }
  }, [orders, statuses, wallets, project, pair, observation, now]);
  if (!result.value)
    return <output>Trigger queue unavailable: {result.error}</output>;
  const queue = result.value,
    pages = Math.max(1, Math.ceil(queue.candidates.length / 20));
  const selectedPage = Math.min(page, pages - 1);
  return (
    <section
      aria-label="Conditional trigger queue"
      className="space-y-2 rounded-md border p-3"
    >
      <h6>Matching conditional levels</h6>
      <output aria-live="polite">
        {queue.candidates.length} matching levels among {queue.checkedLevels}{' '}
        unreserved levels checked. {queue.reservedLevels} reserved or filled
        levels excluded.
      </output>
      {queue.unavailableOrders > 0 && (
        <p>
          {queue.unavailableOrders} drafts need a current selected pool, project
          or saved wallet before monitoring.
        </p>
      )}
      <p>
        Sampled {input.observation.observedAt}. Matches use this foreground pool
        sample and can expire or change. Choose a level to review; preparation
        and signing check its condition again.
      </p>
      <ul className="space-y-2">
        {queue.candidates
          .slice(selectedPage * 20, (selectedPage + 1) * 20)
          .map((candidate) => (
            <li key={`${candidate.order.id}:${candidate.level}`}>
              Level {candidate.level}:{' '}
              {candidate.order.terms.direction === 'at-or-above'
                ? 'at or above'
                : 'at or below'}{' '}
              ${candidate.targetUsd},{' '}
              {conditionalOrderSide(candidate.order) === 'Buy'
                ? 'buy with'
                : 'sell'}{' '}
              {candidate.amount}{' '}
              {conditionalOrderSide(candidate.order) === 'Buy'
                ? 'SOL'
                : 'tokens'}
              . Wallet <code>{candidate.wallet.address}</code>.
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  try {
                    const fresh = conditionalTriggerQueue({
                      ...input,
                      now: Date.now(),
                    }).candidates.find(
                      (c) =>
                        c.order.id === candidate.order.id &&
                        c.level === candidate.level,
                    );
                    if (!fresh)
                      throw new Error(
                        'This level no longer matches. Review the next current sample.',
                      );
                    setError('');
                    onReview(fresh);
                  } catch (failure) {
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : 'Refresh the condition sample.',
                    );
                  }
                }}
              >
                Review matching level {candidate.level}
              </Button>
            </li>
          ))}
      </ul>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={selectedPage === 0}
            onClick={() => setPage(selectedPage - 1)}
          >
            Previous matches
          </Button>
          <span>
            Page {selectedPage + 1} of {pages}
          </span>
          <Button
            variant="outline"
            disabled={selectedPage >= pages - 1}
            onClick={() => setPage(selectedPage + 1)}
          >
            Next matches
          </Button>
        </div>
      )}
      <p>
        Monitoring ends when this page closes. This queue does not reserve
        inventory or approve a trade.
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
