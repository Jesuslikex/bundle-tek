// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  LaunchReviewFocusProvider,
  useLaunchReviewSaveFocus,
} from './launch-review-focus';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Review({ stage }: { stage: 'ready' | 'saving' | 'saved' }) {
  const watch = useLaunchReviewSaveFocus();
  return (
    <details
      open
      className="metadata-review"
      data-review-saving={stage === 'saving' ? 'true' : 'false'}
    >
      <summary>Publish metadata and review launch</summary>
      {stage === 'ready' && (
        <button
          data-review-save-trigger
          onClick={(event) => watch?.(event.currentTarget)}
        >
          Save project
        </button>
      )}
    </details>
  );
}
function App({
  stage,
  other = false,
}: {
  stage: 'ready' | 'saving' | 'saved';
  other?: boolean;
}) {
  return (
    <LaunchReviewFocusProvider>
      <Review key={stage === 'saved' ? 'saved' : 'draft'} stage={stage} />
      {other && <button>Other control</button>}
    </LaunchReviewFocusProvider>
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(stage: 'ready' | 'saving' | 'saved', other = false) {
  await act(async () => root.render(<App stage={stage} other={other} />));
}
async function beginSave() {
  const button = container.querySelector('button')!;
  button.focus();
  await act(async () => button.click());
  await render('saving', true);
}
it('returns focus to the new review summary after a focused save finishes', async () => {
  await render('ready', true);
  await beginSave();
  expect(document.activeElement).toBe(document.body);
  await render('saved', true);
  expect(document.activeElement).toBe(container.querySelector('summary'));
});
it('does not steal focus when the user moves to another control', async () => {
  await render('ready', true);
  await beginSave();
  const other = container.querySelector('button')!;
  other.focus();
  await render('saved', true);
  expect(document.activeElement).toBe(other);
});
it('does not restore focus after a later pointer action on the page', async () => {
  await render('ready', true);
  await beginSave();
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await render('saved', true);
  expect(document.activeElement).toBe(document.body);
});
it('returns focus to the retry button after a failed save', async () => {
  await render('ready', true);
  await beginSave();
  await render('ready', true);
  expect(document.activeElement).toBe(
    container.querySelector('[data-review-save-trigger]'),
  );
});
it('does not restore focus after the user scrolls away', async () => {
  await render('ready', true);
  await beginSave();
  document.body.dispatchEvent(new Event('wheel', { bubbles: true }));
  await render('saved', true);
  expect(document.activeElement).toBe(document.body);
});
it('does not cancel on a modifier alone', async () => {
  await render('ready', true);
  await beginSave();
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }),
  );
  await render('saved', true);
  expect(document.activeElement).toBe(container.querySelector('summary'));
});
it('cancels when Enter repeats to avoid activating the restored control', async () => {
  await render('ready', true);
  await beginSave();
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }),
  );
  await render('saved', true);
  expect(document.activeElement).toBe(document.body);
});
it('does not move focus for a save initiated while another element is focused', async () => {
  await render('ready', true);
  const buttons = container.querySelectorAll('button');
  buttons[1].focus();
  await act(async () => buttons[0].click());
  await render('saving', true);
  await render('saved', true);
  expect(document.activeElement).toBe(container.querySelector('button'));
});
