// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { largeLayerReviewFixture } from '../../test/launch-layer-review-fixture';
import { LayerBudgetReview } from './pump-layer-planner';
import { LaunchLayerSetupSummary } from './launch-layer-setup-summary';
import { layerDisplay } from '@/lib/launch-layer-client';
import { layerNativeFixture } from '../../test/launch-layer-native-fixture';
import { createLaunchLayerSetup } from '@/lib/launch-layer-setup';

vi.stubGlobal('React', React);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

it('shows bound role counts and preserves subsecond timing without inventing readiness', async () => {
  const envelope = await largeLayerReviewFixture();
  envelope.terms.delays.frontToBackDelayMs = 701;
  const before = JSON.stringify(envelope),
    host = document.createElement('div'),
    root = createRoot(host);
  try {
    await act(async () =>
      root.render(<LaunchLayerSetupSummary envelope={envelope} />),
    );
    const values = Object.fromEntries(
      [...host.querySelectorAll('section > dl > div')].map((tile) => [
        tile.querySelector('dt')!.textContent,
        tile.querySelector('dd')!.textContent,
      ]),
    );
    expect(values['Front buyers']).toBe('56');
    expect(values['Back buyers']).toBe('1');
    expect(values['Temporary holders']).toBe('1');
    expect(values['Final holders']).toBe('2');
    expect(values['Front to Back delay']).toBe('0.701s');
    expect(values['Back to temporary delay']).toBe('0.5s');
    expect(values['Funder']).toBe('1 wallet');
    expect(values['Preset']).toBe('Clean Build');
    expect(values['Mode']).toBe('Sequenced');
    expect(host.textContent).toContain(envelope.terms.binding.target.mint);
    expect(host.textContent).toContain(envelope.terms.quote.address);
    expect(host.textContent).toContain(
      'Slippage, rewards and fee sharing are not confirmed here',
    );
    expect(host.querySelector('button,input')).toBeNull();
    expect(host.querySelector('details')!.open).toBe(false);
    expect(values['Buy delay']).toBe('0s (none saved)');
    expect(values['Initial buy delay']).toBe('0s (none saved)');
    expect(host.textContent).toContain('Saved name: $TOKEN Untitled Plan');
    expect(JSON.stringify(envelope)).toBe(before);
  } finally {
    await act(async () => root.unmount());
  }
});

it('shows original uploaded artwork and saved fee shares without presenting them as executed', async () => {
  const { f, plan } = await layerNativeFixture(),
    host = document.createElement('div'),
    root = createRoot(host);
  f.document.identity.artworkUrl = '/api/artwork/' + '1'.repeat(64);
  f.document.identity.website = 'https://example.test/original';
  f.document.options.settings.pumpfun.feeSharing = true;
  f.document.options.settings.pumpfun.feeShares = [
    { address: f.address(1), shareBps: 3333 },
    { address: f.address(2), shareBps: 6667 },
  ];
  const setup = createLaunchLayerSetup(f.document, plan.envelope, {
    projectId: f.selection.projectId,
    projectUpdatedAt: f.updatedAt,
    snapshotSha256: 'a'.repeat(64),
  });
  f.document.identity.artworkUrl = '/api/artwork/' + '2'.repeat(64);
  try {
    await act(async () =>
      root.render(
        <LaunchLayerSetupSummary envelope={plan.envelope} setup={setup} />,
      ),
    );
    const imageUrl = new URL(host.querySelector('img')!.src);
    expect(imageUrl.origin).toBe(document.location.origin);
    expect(imageUrl.pathname).toBe(setup.identity.artworkUrl);
    expect(host.querySelector('a')!.getAttribute('href')).toBe(
      'https://example.test/original',
    );
    expect(host.textContent).toContain('2 recipient(s)');
    expect(host.textContent).toContain('33.33%');
    expect(host.textContent).toContain('66.67%');
    expect(host.textContent).toContain(
      'saved requests, not verified execution settings',
    );
    expect([...host.querySelectorAll('details')].every((d) => !d.open)).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it('explains missing saved artwork and retries only on an explicit click', async () => {
  const { f, plan } = await layerNativeFixture(),
    host = document.createElement('div'),
    root = createRoot(host);
  f.document.identity.artworkUrl = '/api/artwork/' + '1'.repeat(64);
  const setup = createLaunchLayerSetup(f.document, plan.envelope, {
    projectId: f.selection.projectId,
    projectUpdatedAt: f.updatedAt,
    snapshotSha256: 'a'.repeat(64),
  });
  try {
    await act(async () =>
      root.render(
        <LaunchLayerSetupSummary envelope={plan.envelope} setup={setup} />,
      ),
    );
    await act(async () =>
      host.querySelector('img')!.dispatchEvent(new Event('error')),
    );
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('Saved artwork unavailable');
    const retry = host.querySelector('button')!;
    expect(retry.textContent).toBe('Retry artwork');
    await act(async () => retry.click());
    const retried = new URL(host.querySelector('img')!.src);
    expect(retried.origin).toBe(document.location.origin);
    expect(retried.pathname).toBe(setup.identity.artworkUrl);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(['external', 'stale', 'unsafe-url', 'authority'] as const)(
  'does not automatically load untrusted artwork or mismatched setup: %s',
  async (kind) => {
    const { f, plan } = await layerNativeFixture(),
      host = document.createElement('div'),
      root = createRoot(host);
    f.document.identity.artworkUrl = 'https://example.test/saved.png';
    const setup = createLaunchLayerSetup(f.document, plan.envelope, {
      projectId: f.selection.projectId,
      projectUpdatedAt: f.updatedAt,
      snapshotSha256: 'a'.repeat(64),
    });
    if (kind === 'stale') setup.termsSha256 = 'b'.repeat(64);
    if (kind === 'unsafe-url') setup.identity.website = 'javascript:alert(1)';
    if (kind === 'authority') Object.assign(setup, { signingAllowed: true });
    try {
      await act(async () =>
        root.render(
          <LaunchLayerSetupSummary envelope={plan.envelope} setup={setup} />,
        ),
      );
      expect(host.querySelector('img')).toBeNull();
      if (kind === 'external') {
        expect(host.querySelector('a')!.textContent).toBe(
          'Open saved external artwork',
        );
        expect(host.querySelector('a')!.getAttribute('rel')).toContain(
          'noreferrer',
        );
      } else {
        expect(host.querySelector('a')).toBeNull();
        expect(host.textContent).toContain(
          'Artwork and venue choices are unavailable for this review',
        );
      }
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it.each([
  'unreadable',
  'wrong-venue',
  'wrong-quote',
  'wrong-holder-count',
] as const)(
  'does not invent saved launch metadata when the bound plan is %s',
  async (kind) => {
    const envelope = await largeLayerReviewFixture(),
      host = document.createElement('div'),
      root = createRoot(host);
    const plan = JSON.parse(envelope.terms.binding.savedPlanJson);
    if (kind === 'wrong-venue') plan.launchpad = 'StonkFun';
    if (kind === 'wrong-quote') plan.currency = 'USDC';
    if (kind === 'wrong-holder-count') plan.holderCount += 1;
    envelope.terms.binding.savedPlanJson =
      kind === 'unreadable' ? '{' : JSON.stringify(plan);
    try {
      await act(async () =>
        root.render(<LaunchLayerSetupSummary envelope={envelope} />),
      );
      expect(host.querySelector('output')!.textContent).toContain(
        'Saved launch details are unavailable',
      );
      expect(host.textContent).not.toContain('Clean Build');
      expect(
        [...host.querySelectorAll('dt')].find(
          (node) => node.textContent === 'Front buyers',
        )!.nextElementSibling!.textContent,
      ).toBe('56');
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it('distinguishes draft and saved reviews and labels the configuration headings uniquely', async () => {
  const envelope = await largeLayerReviewFixture(),
    host = document.createElement('div'),
    root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <>
          <LayerBudgetReview envelope={envelope} contextLabel="Draft layer" />
          <LayerBudgetReview envelope={envelope} contextLabel="Saved layer" />
        </>,
      ),
    );
    expect(
      host.querySelector('[aria-label="Draft layer budget review"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[aria-label="Saved layer budget review"]'),
    ).not.toBeNull();
    const sections = [...host.querySelectorAll('section[aria-labelledby]')];
    expect(sections).toHaveLength(2);
    const ids = sections.map((s) => s.getAttribute('aria-labelledby')!);
    expect(new Set(ids).size).toBe(2);
    expect(host.querySelector(`[id="${ids[0]}"]`)!.textContent).toBe(
      'Draft layer configuration',
    );
    expect(host.querySelector(`[id="${ids[1]}"]`)!.textContent).toBe(
      'Saved layer configuration',
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(['empty', 'uploaded', 'unreadable-name'] as const)(
  'keeps StonkFun setup useful without an empty details panel: %s',
  async (kind) => {
    const { f, plan } = await layerNativeFixture(true),
      host = document.createElement('div'),
      root = createRoot(host);
    if (kind !== 'empty')
      f.document.identity.artworkUrl = '/api/artwork/' + '1'.repeat(64);
    const setup = createLaunchLayerSetup(f.document, plan.envelope, {
      projectId: f.selection.projectId,
      projectUpdatedAt: f.updatedAt,
      snapshotSha256: 'a'.repeat(64),
    });
    if (kind === 'unreadable-name')
      plan.envelope.terms.binding.savedPlanJson = '{';
    try {
      await act(async () =>
        root.render(
          <LaunchLayerSetupSummary envelope={plan.envelope} setup={setup} />,
        ),
      );
      for (const label of ['Holder rewards', 'Creator fee', 'Fee sharing'])
        expect(
          [...host.querySelectorAll('dt')].find((n) => n.textContent === label)!
            .nextElementSibling!.textContent,
        ).toBe('Not applicable (StonkFun)');
      expect(host.querySelectorAll('ul')).toHaveLength(0);
      expect(
        [...host.querySelectorAll('summary')].some((n) =>
          n.textContent!.startsWith('Saved project artwork'),
        ),
      ).toBe(false);
      expect(Boolean(host.querySelector('img'))).toBe(kind !== 'empty');
      if (kind === 'unreadable-name')
        expect(host.textContent).toContain(
          'Saved launch details are unavailable',
        );
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it.each([null, 'a'.repeat(64)])(
  'describes the original setup source correctly for snapshot %s',
  async (sha) => {
    const { f, plan } = await layerNativeFixture(),
      host = document.createElement('div'),
      root = createRoot(host);
    const setup = createLaunchLayerSetup(f.document, plan.envelope, {
      projectId: f.selection.projectId,
      projectUpdatedAt: f.updatedAt,
      snapshotSha256: sha,
    });
    try {
      await act(async () =>
        root.render(
          <LaunchLayerSetupSummary envelope={plan.envelope} setup={setup} />,
        ),
      );
      expect(host.textContent).toContain(
        sha === null
          ? 'come from the loaded saved project'
          : 'come from the retained project snapshot',
      );
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it('shows explicitly saved buy timings from the validated snapshot', async () => {
  const envelope = await largeLayerReviewFixture(),
    host = document.createElement('div'),
    root = createRoot(host);
  const plan = JSON.parse(envelope.terms.binding.savedPlanJson);
  plan.timing = { buyDelayMs: 700, initialBuyDelayMs: 1234 };
  envelope.terms.binding.savedPlanJson = JSON.stringify(plan);
  try {
    await act(async () =>
      root.render(<LaunchLayerSetupSummary envelope={envelope} />),
    );
    const value = (label: string) =>
      [...host.querySelectorAll('dt')].find((n) => n.textContent === label)!
        .nextElementSibling!.textContent;
    expect(value('Buy delay')).toBe('0.7s');
    expect(value('Initial buy delay')).toBe('1.234s');
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([false, true])(
  'wallet SOL ceilings keep quote-token buys separate (stock=%s)',
  async (stock) => {
    const envelope = await largeLayerReviewFixture(stock),
      host = document.createElement('div'),
      root = createRoot(host);
    const before = JSON.stringify(envelope);
    try {
      await act(async () =>
        root.render(<LayerBudgetReview envelope={envelope} />),
      );
      const row =
        host.querySelectorAll('ol li')[envelope.terms.roles.developer ? 2 : 1];
      const member = envelope.terms.roles.front[0];
      const native =
        BigInt(member.maximumNetworkFeeLamports) +
        BigInt(member.maximumAccountRentLamports) +
        BigInt(member.retainedNativeReserveLamports) +
        (stock ? 0n : BigInt(member.maximumBuyQuoteRaw));
      const text = layerDisplay(String(native), 9);
      expect(row.textContent).toContain('Front buyer 1');
      expect(row.textContent).toContain(
        `${stock ? 'SOL ceiling (excludes TSLAX buy)' : 'SOL ceiling (includes buy)'} ≤ ${text} SOL`,
      );
      expect(row.textContent).toContain(envelope.terms.quote.symbol);
      expect(row.querySelector('details')!.open).toBe(false);
      expect(row.querySelector('details')!.textContent).toContain('rent ≤');
      expect(
        row.querySelector('summary')!.getAttribute('aria-label'),
      ).toContain('Front buyer 1:');
      expect(JSON.stringify(envelope)).toBe(before);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
