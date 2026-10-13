// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TokenDetailsForm } from './token-details-form';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(plan = DEFAULT_LAUNCH_PLAN) {
  act(() =>
    root.render(
      <TokenDetailsForm plan={plan} onChange={() => {}} onNext={() => {}} />,
    ),
  );
  return {
    name: container.querySelector<HTMLInputElement>('#project-name')!,
    ticker: container.querySelector<HTMLInputElement>('#project-symbol')!,
  };
}

it('selects the default name and ticker on focus so typing replaces them', () => {
  const { name, ticker } = render();
  for (const input of [name, ticker]) {
    act(() => input.focus());
    expect([input.selectionStart, input.selectionEnd]).toEqual([
      0,
      input.value.length,
    ]);
  }
});

it('leaves a user-entered name and ticker alone on focus', () => {
  const { name, ticker } = render({
    ...DEFAULT_LAUNCH_PLAN,
    tokenName: 'My Project',
    ticker: 'MYP',
  });
  for (const input of [name, ticker]) {
    input.setSelectionRange(input.value.length, input.value.length);
    act(() => input.focus());
    expect(input.selectionStart).toBe(input.value.length);
  }
});
