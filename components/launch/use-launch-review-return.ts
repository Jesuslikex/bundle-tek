'use client';
import { useEffect, useRef } from 'react';

/** Return to the current draft without saving, publishing or granting consent. */
export function useLaunchReviewReturn(
  view: string,
  changeView: (view: 'token') => void,
) {
  const pending = useRef(false);
  useEffect(() => {
    if (view !== 'token' || !pending.current) return;
    pending.current = false;
    const review = document.querySelector<HTMLDetailsElement>(
      'details.metadata-review',
    );
    if (!review) return;
    review.open = true;
    review.scrollIntoView?.({ block: 'start' });
    review.querySelector<HTMLElement>('summary')?.focus();
  }, [view]);
  return () => {
    pending.current = true;
    changeView('token');
  };
}
