// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { VenueMark, remoteTokenLogo } from './venue-mark';
import { TOKEN_LOGOS } from './token-logos';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const UNKNOWN = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const bundled = [...TOKEN_LOGOS][0];

it('uses the bundled logo when there is one', async () => {
  await act(async () => root.render(<VenueMark name="X" address={bundled} />));
  expect(container.querySelector('img')!.getAttribute('src')).toBe(
    `/logos/tokens/${bundled}.png`,
  );
});
it('fetches a remote icon for an unknown Solana mint and falls back to the monogram on error', async () => {
  expect(TOKEN_LOGOS.has(UNKNOWN)).toBe(false);
  await act(async () =>
    root.render(<VenueMark name="Mystery" address={UNKNOWN} />),
  );
  const img = container.querySelector('img')!;
  expect(img.getAttribute('src')).toBe(remoteTokenLogo(UNKNOWN));
  expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
  await act(async () => img.dispatchEvent(new Event('error')));
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('.venue-monogram')!.textContent).toBe('M');
});
it('never builds a remote URL for non-Solana or missing addresses', async () => {
  expect(remoteTokenLogo(undefined)).toBeNull();
  expect(
    remoteTokenLogo('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  ).toBeNull();
  expect(remoteTokenLogo('../../evil')).toBeNull();
  await act(async () => root.render(<VenueMark name="Nameless" />));
  expect(container.querySelector('img')).toBeNull();
});
