// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { LayerBudgetReview } from './pump-layer-planner';
import { largeLayerReviewFixture } from '../../test/launch-layer-review-fixture';

vi.stubGlobal('React', React);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
it('pages the full declared wallet set, filters roles/addresses and preserves every original term', async () => {
  const envelope = await largeLayerReviewFixture();
  const original = JSON.stringify(envelope);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<LayerBudgetReview envelope={envelope} />),
    );
    const rows = () => host.querySelectorAll('ol li');
    const click = async (label: string) =>
      act(async () => {
        const button = [...host.querySelectorAll('button')].find(
          (node) => node.textContent === label,
        );
        expect(button).toBeDefined();
        button!.click();
      });
    expect(rows()).toHaveLength(25);
    expect(host.textContent).toContain('62 of 62 wallets');
    const totals = host.querySelector(
      'dl[aria-label="Full plan ceilings"]',
    )!.textContent;
    await click('Next review wallets');
    await click('Next review wallets');
    expect(rows()).toHaveLength(12);
    expect(host.textContent).toContain('page 3 of 3');
    const select = host.querySelector('select')!;
    await act(async () => {
      select.value = 'front';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.textContent).toContain('56 of 62 wallets');
    expect(host.textContent).toContain('page 1 of 3');
    expect(rows()[0].textContent).toContain('Front buyer 1');
    const input = host.querySelector<HTMLInputElement>('input[id$="-search"]')!;
    const search = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await search(envelope.terms.roles.front.at(-1)!.wallet.address);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('Front buyer 56');
    await search('not-a-wallet');
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain('No wallets match');
    await click('Show all review wallets');
    expect(rows()).toHaveLength(25);
    expect(
      host.querySelector('dl[aria-label="Full plan ceilings"]')!.textContent,
    ).toBe(totals);
    expect(JSON.stringify(envelope)).toBe(original);
    expect(host.textContent).toContain('not verified costs');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('keeps stock buys separate from native ceilings in the filtered review', async () => {
  const envelope = await largeLayerReviewFixture(true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<LayerBudgetReview envelope={envelope} />),
    );
    expect(host.textContent).toContain(
      'TSLAX buys are separate from the SOL total',
    );
    expect(host.querySelector('ol')!.textContent).toContain('TSLAX');
    expect(envelope.terms.signingAllowed).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
