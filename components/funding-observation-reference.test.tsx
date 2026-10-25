// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  FundingObservationReference,
  type FundingObservationReferenceProps,
} from './funding-observation-reference';

const address = bs58.encode(new Uint8Array(32).fill(1));
const funder = bs58.encode(new Uint8Array(32).fill(2));
const signature = bs58.encode(new Uint8Array(64).fill(3));
const props: FundingObservationReferenceProps = {
  address,
  revision: 8,
  source: 'saved',
  funding: { signature, slot: 123, blockTime: 1700000000 },
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
  });
});
async function render(value = props) {
  await act(async () =>
    root.render(<FundingObservationReference {...value} />),
  );
}
async function copy() {
  await act(async () => host.querySelector('button')!.click());
}
function clipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}
it.each(['saved', 'provider'] as const)(
  'shows complete loaded %s evidence, collapsed with a guarded explicit external link and no network',
  async (source) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await render({
      ...props,
      source,
      funding: { ...props.funding, funders: [funder] },
    });
    expect(host.querySelector('details')!.open).toBe(false);
    const reference = host.querySelector('pre')!.textContent!;
    for (const text of [
      address,
      signature,
      funder,
      `Evidence source: ${source}`,
      'Wallet revision: 8',
      'Slot: 123',
      '2023-11-14T22:13:20.000Z',
      '1700000000',
      'not a fresh transaction verification',
    ])
      expect(reference).toContain(text);
    const link = host.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(
      `https://solscan.io/tx/${signature}`,
    );
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    await act(async () => {
      host.querySelector('details')!.open = true;
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(host.textContent).toContain('leaves Bundle');
  },
);
it('does not fabricate funding sources or infer wallet age or ownership', async () => {
  await render();
  expect(host.querySelector('pre')!.textContent).toContain(
    'Reported funding sources: not included in this observation',
  );
  expect(host.textContent).toContain(
    'not a fresh transaction verification, complete history or proof of ownership',
  );
  expect(host.textContent).not.toContain('Wallet age:');
});
it.each([
  { ...props, address: 'invalid' },
  { ...props, revision: 0 },
  { ...props, source: 'unknown' },
  { ...props, funding: { ...props.funding, signature: address } },
  { ...props, funding: { ...props.funding, signature: ` ${signature}` } },
  { ...props, funding: { ...props.funding, slot: NaN } },
  { ...props, funding: { ...props.funding, slot: 1.5 } },
  { ...props, funding: { ...props.funding, blockTime: Infinity } },
  { ...props, funding: { ...props.funding, blockTime: -1 } },
  {
    ...props,
    funding: { ...props.funding, blockTime: Number.MAX_SAFE_INTEGER },
  },
  { ...props, funding: { ...props.funding, funders: ['bad'] } },
  { ...props, funding: null },
])(
  'refuses malformed public evidence without a link or copy control (%#)',
  async (value) => {
    await render(value as FundingObservationReferenceProps);
    expect(host.textContent).toBe('Funding evidence reference is unavailable.');
    expect(host.querySelector('a, button, pre')).toBeNull();
  },
);
it('copies exactly the full loaded reference and reports success without network or clipboard reads', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  clipboard(writeText);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await render();
  const reference = host.querySelector('pre')!.textContent!;
  await copy();
  expect(writeText).toHaveBeenCalledExactlyOnceWith(reference);
  expect(host.querySelector('output')!.textContent).toBe(
    'Funding reference copied.',
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['missing', 'rejected'])(
  'keeps a selectable reference after %s clipboard access',
  async (mode) => {
    if (mode === 'rejected')
      clipboard(vi.fn().mockRejectedValue(Error('private raw failure')));
    await render();
    await copy();
    expect(host.querySelector('pre')!.textContent).toContain(signature);
    expect(host.querySelector('output')!.textContent).toContain(
      'copy it manually',
    );
    expect(host.textContent).not.toContain('private raw failure');
  },
);
it.each(['resolve', 'reject'])(
  'discards deferred %s after the same wallet observation changes',
  async (outcome) => {
    let resolve!: () => void, reject!: (error: Error) => void;
    clipboard(
      vi.fn(
        () =>
          new Promise<void>((ok, fail) => {
            resolve = ok;
            reject = fail;
          }),
      ),
    );
    await render();
    await copy();
    await render({ ...props, funding: { ...props.funding, slot: 124 } });
    await act(async () => {
      if (outcome === 'resolve') resolve();
      else reject(Error('old'));
    });
    expect(host.querySelector('output')!.textContent).toBe('');
    expect(host.querySelector('pre')!.textContent).toContain('Slot: 124');
  },
);
it('discards deferred copy after unmount or refusal', async () => {
  let resolve!: () => void;
  clipboard(
    vi.fn(
      () =>
        new Promise<void>((ok) => {
          resolve = ok;
        }),
    ),
  );
  await render();
  await copy();
  await render({ ...props, address: 'invalid' });
  await act(async () => resolve());
  expect(host.querySelector('output')).toBeNull();
  await act(async () => root.unmount());
  root = createRoot(host);
});

it.each([
  { ...props, revision: 9 },
  { ...props, address: funder },
  { ...props, source: 'provider' as const },
  { ...props, funding: { ...props.funding, blockTime: 1700000001 } },
  {
    ...props,
    funding: {
      ...props.funding,
      signature: bs58.encode(new Uint8Array(64).fill(4)),
    },
  },
  { ...props, funding: { ...props.funding, funders: [funder] } },
])(
  'invalidates deferred clipboard work when any evidence binding changes (%#)',
  async (next) => {
    let reject!: (error: Error) => void;
    clipboard(
      vi.fn(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          }),
      ),
    );
    await render();
    await copy();
    await render(next);
    await act(async () => reject(Error('stale clipboard error')));
    expect(host.querySelector('output')!.textContent).toBe('');
  },
);

it.each(['resolve', 'reject'])(
  'ignores deferred %s after a real unmount',
  async (outcome) => {
    let resolve!: () => void, reject!: (error: Error) => void;
    clipboard(
      vi.fn(
        () =>
          new Promise<void>((ok, fail) => {
            resolve = ok;
            reject = fail;
          }),
      ),
    );
    await render();
    await copy();
    await act(async () => root.unmount());
    await act(async () => {
      if (outcome === 'resolve') resolve();
      else reject(Error('late after unmount'));
    });
    expect(host.textContent).toBe('');
    root = createRoot(host);
  },
);
