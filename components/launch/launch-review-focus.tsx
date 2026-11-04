'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';

const ReviewSaveFocus = createContext<
  ((button: HTMLButtonElement) => void) | null
>(null);

export function LaunchReviewFocusProvider({ children }: { children: ReactNode }) {
  const cancelCurrent = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelCurrent.current?.(), []);

  function watchSave(button: HTMLButtonElement) {
    cancelCurrent.current?.();
    if (document.activeElement !== button) return;

    const cancel = () => {
      observer.disconnect();
      clearTimeout(timeout);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      document.removeEventListener('focusin', onFocus, true);
      if (cancelCurrent.current === cancel) cancelCurrent.current = null;
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target !== button && event.target !== document.body) cancel();
    };
    const observer = new MutationObserver(() => {
      if (button.isConnected || document.activeElement !== document.body) return;
      const panels = document.querySelectorAll<HTMLDetailsElement>(
        '.metadata-review',
      );
      if (panels.length !== 1 || panels[0].dataset.reviewSaving !== 'false')
        return;
      const summary = panels[0].querySelector<HTMLElement>(':scope > summary');
      if (!summary) return;
      cancel();
      summary.focus();
    });
    const timeout = setTimeout(cancel, 30_000);
    cancelCurrent.current = cancel;
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.addEventListener('focusin', onFocus, true);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-review-saving'],
    });
  }

  return (
    <ReviewSaveFocus.Provider value={watchSave}>
      {children}
    </ReviewSaveFocus.Provider>
  );
}

export const useLaunchReviewSaveFocus = () => useContext(ReviewSaveFocus);
