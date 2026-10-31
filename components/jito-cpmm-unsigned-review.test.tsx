// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JitoCpmmUnsignedReviewPanel } from './jito-cpmm-unsigned-review';
import {
  createJitoCpmmUnsignedReview,
  saveJitoCpmmUnsignedReview,
  openJitoCpmmUnsignedReview,
} from '../lib/jito-cpmm-unsigned-review';
import {
  unsignedReviewContext as scope,
  unsignedReviewFacts,
} from '../test/jito-cpmm-unsigned-review-fixture';
let root: Root, host: HTMLDivElement;
const network = vi.fn();
let current = true;
const props = () => ({
  ...scope,
  disabled: false,
  isContextCurrent: () => current,
});
beforeEach(async () => {
  current = true;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  // The SDK installs Node AbortSignal in jsdom. Match its native EventTarget
  // brand rather than weakening the production transport's intrinsic checks.
  vi.stubGlobal(
    'EventTarget',
    Object.getPrototypeOf(AbortSignal.prototype).constructor,
  );
  vi.stubGlobal('fetch', network);
  network.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<JitoCpmmUnsignedReviewPanel {...props()} />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function file(data: unknown, pending?: Promise<ArrayBuffer>) {
  const raw = Uint8Array.from(new TextEncoder().encode(JSON.stringify(data)));
  const input = host.querySelector('input[type=file]')! as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [
      {
        size: raw.byteLength,
        arrayBuffer: () => pending ?? Promise.resolve(raw.buffer),
      },
    ],
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  if (!pending)
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        (host.querySelector('input[type=file]') as HTMLInputElement).disabled,
      ).toBe(false);
    });
}
it('does no mount/network work and shows an unchecked, exact historical review', async () => {
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
  const review = await createJitoCpmmUnsignedReview(unsignedReviewFacts());
  await file(review);
  expect(host.textContent).toContain('encoded minimum output 190000');
  expect(host.textContent).toContain('span 29 of 32');
  expect(host.textContent).toContain('Current validity has not been checked');
  expect(host.textContent).toContain(
    'public-reference research flow does not qualify your saved user bundle',
  );
  expect(
    (host.querySelector('input[type=checkbox]') as HTMLInputElement).checked,
  ).toBe(false);
  expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(network).not.toHaveBeenCalled();
});
it('exports only after separate approval and reopening never restores consent', async () => {
  const review = await createJitoCpmmUnsignedReview(unsignedReviewFacts());
  await file(review);
  const downloaded: Blob[] = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((b: Blob) => {
      downloaded.push(b);
      return 'blob:review';
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await act(async () =>
    (host.querySelector('input[type=checkbox]') as HTMLInputElement).click(),
  );
  await act(async () =>
    (host.querySelector('button') as HTMLButtonElement).click(),
  );
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(downloaded).toHaveLength(1);
  });
  expect(host.textContent).toContain('cannot sign, send or restore approval');
  expect(
    (host.querySelector('input[type=checkbox]') as HTMLInputElement).checked,
  ).toBe(false);
  const saved = await saveJitoCpmmUnsignedReview(review, scope, true);
  await file(saved);
  expect(host.textContent).toContain('Historical review reopened');
  expect(
    (host.querySelector('input[type=checkbox]') as HTMLInputElement).checked,
  ).toBe(false);
  expect(network).not.toHaveBeenCalled();
  // Independently reopen the actual downloaded bytes, not a parallel fixture.
  const content = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(Error('Expected text download.'));
    reader.onerror = reject;
    reader.readAsText(downloaded[0]);
  });
  expect(
    (
      await openJitoCpmmUnsignedReview(
        Uint8Array.from(new TextEncoder().encode(content)),
        scope,
      )
    ).review.sha256,
  ).toBe(review.sha256);
});
it('clears approval when a new file fails validation', async () => {
  await file(await createJitoCpmmUnsignedReview(unsignedReviewFacts()));
  await act(async () =>
    (host.querySelector('input[type=checkbox]') as HTMLInputElement).click(),
  );
  await file({ format: 'no' });
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
  expect(host.textContent).toContain('No action was resumed');
});
it('refuses a saved review belonging to another account and never resumes a provider call', async () => {
  const review = await createJitoCpmmUnsignedReview(unsignedReviewFacts());
  await file(
    await saveJitoCpmmUnsignedReview(
      review,
      { ...scope, ownerScope: 'cd'.repeat(32) },
      true,
    ),
  );
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
  expect(host.textContent).toContain('different account');
  expect(network).not.toHaveBeenCalled();
});
it('does not publish a file read that finishes after the context changes', async () => {
  const review = await createJitoCpmmUnsignedReview(unsignedReviewFacts());
  let finish!: (value: ArrayBuffer) => void;
  const pending = new Promise<ArrayBuffer>((resolve) => {
    finish = resolve;
  });
  await file(review, pending);
  current = false;
  await act(async () => {
    finish(new TextEncoder().encode(JSON.stringify(review)).buffer);
  });
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
  expect(network).not.toHaveBeenCalled();
});
it('clears all review and approval state on an account or disabled-context change', async () => {
  await file(await createJitoCpmmUnsignedReview(unsignedReviewFacts()));
  await act(async () =>
    (host.querySelector('input[type=checkbox]') as HTMLInputElement).click(),
  );
  await act(async () =>
    root.render(
      <JitoCpmmUnsignedReviewPanel {...props()} ownerScope={'cd'.repeat(32)} />,
    ),
  );
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
  await act(async () =>
    root.render(<JitoCpmmUnsignedReviewPanel {...props()} disabled />),
  );
  expect(
    (host.querySelector('input[type=file]') as HTMLInputElement).disabled,
  ).toBe(true);
});
it('releases a stalled file read on its deadline without publishing or resuming work', async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  await file(
    await createJitoCpmmUnsignedReview(unsignedReviewFacts()),
    new Promise<ArrayBuffer>(() => {}),
  );
  expect(
    (host.querySelector('input[type=file]') as HTMLInputElement).disabled,
  ).toBe(true);
  await act(async () => deadline.abort());
  expect(host.textContent).toContain('No action was resumed');
  expect(
    (host.querySelector('input[type=file]') as HTMLInputElement).disabled,
  ).toBe(false);
  expect(network).not.toHaveBeenCalled();
});
