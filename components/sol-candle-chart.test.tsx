// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PoolCandleChart, ImportedPoolCandles } from './imported-pool-candles';
import { chartPriceContext } from '@/lib/chart-price-context';
import {
  chartDrawingStorageKey,
  parseChartDrawingDocument,
} from '@/lib/chart-drawing-document';
import { chartExecutionAverages } from '@/lib/chart-execution-averages';
import {
  acquisitionReceipt,
  acquisitionId,
  acquisitionMint,
} from '../test/imported-sell-acquisition-fixture';
import type { PoolCandles } from '@/lib/pool-candles';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
const usd: PoolCandles = {
  chain: 'Solana',
  address: acquisitionMint,
  pool: '11111111111111111111111111111111',
  interval: '1h',
  candles: [
    { time: 1791846000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
  ],
  observedAt: '2026-10-13T00:00:00.000Z',
  source: 'api.geckoterminal.com',
  executionAllowed: false,
  projectRevision: 1,
};
const sol: PoolCandles = {
  ...usd,
  currency: 'sol',
  quoteMint: 'So11111111111111111111111111111111111111112',
};
const project: ImportedTokenProject = {
  id: acquisitionId(1),
  revision: 1,
  archived: false,
  updatedAt: usd.observedAt,
  document: {
    format: 'imported-token-project-v1',
    executionAllowed: false,
    token: {
      chain: 'Solana',
      address: acquisitionMint,
      name: 'Fixture',
      symbol: 'TST',
      decimals: 0,
      totalSupplyRaw: '1000',
      observedAt: usd.observedAt,
      source: 'fixture.test',
    },
  },
};
let root: Root | undefined, container: HTMLDivElement;
async function mount(element: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}
async function click(text: string) {
  const b = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  );
  if (!b) throw new Error('Button missing ' + text);
  await act(async () => b.click());
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size;
    },
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  } satisfies Storage);
});
afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    container.remove();
    root = undefined;
  }
  vi.unstubAllGlobals();
});
it('draws receipt-weighted averages on SOL axes only, clips outliers and labels their basis', () => {
  const buy = acquisitionReceipt(2, 'Buy', '1'),
    sell = acquisitionReceipt(3, 'Sell', '2');
  buy.document.nativeSettlementRaw = '-600000000';
  sell.document.nativeSettlementRaw = '2400000000';
  const averages = chartExecutionAverages(
    [buy, sell],
    project.id,
    acquisitionMint,
    0,
  );
  const html = renderToStaticMarkup(
    <PoolCandleChart
      snapshot={sol}
      projectId={project.id}
      executionAverages={averages}
    />,
  );
  expect(html).toContain('Recorded average buy price SOL');
  expect(html).toContain('Recorded average sell price SOL');
  const parsed = document.createElement('div');
  parsed.innerHTML = html;
  expect(
    Number(
      parsed
        .querySelector('g[aria-label="Recorded average buy price SOL"] line')!
        .getAttribute('y1'),
    ),
  ).toBeCloseTo(188, 10);
  expect(html).toContain('provider units');
  expect(
    renderToStaticMarkup(
      <PoolCandleChart snapshot={usd} executionAverages={averages} />,
    ),
  ).not.toContain('Recorded average buy price SOL');
  buy.document.nativeSettlementRaw = '-9000000000';
  const outside = chartExecutionAverages([buy], project.id, acquisitionMint, 0);
  const clipped = renderToStaticMarkup(
    <PoolCandleChart snapshot={sol} executionAverages={outside} />,
  );
  expect(clipped).not.toContain('Recorded average buy price SOL');
  expect(clipped).toContain('outside the current candle price range');
});
it('preserves legacy USD drawing keys while preventing cross-currency restores and wrong quote contexts', () => {
  const legacy = `${project.id}:Solana:${acquisitionMint}:${usd.pool}:1h`;
  expect(chartPriceContext(usd, project.id)).toBe(legacy);
  const native = chartPriceContext(sol, project.id);
  expect(native).toBe(legacy + ':sol');
  expect(chartDrawingStorageKey(native)).not.toBe(
    chartDrawingStorageKey(legacy),
  );
  const saved = JSON.stringify({
    format: 'bundle-chart-drawings-v1',
    context: legacy,
    savedAt: usd.observedAt,
    guides: [0.8],
    trends: [],
  });
  expect(() => parseChartDrawingDocument(saved, native)).toThrow();
  expect(() =>
    chartPriceContext({ ...sol, quoteMint: usd.pool }, project.id),
  ).toThrow();
});
it('saves and restores price guides independently when the mounted chart changes denomination', async () => {
  await mount(<PoolCandleChart snapshot={usd} projectId={project.id} />);
  const input = container.querySelector(
    'input[aria-label="Price guide USD"]',
  )! as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, '0.8');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Add guide');
  await click('Save chart drawings');
  expect(
    localStorage.getItem(
      chartDrawingStorageKey(chartPriceContext(usd, project.id)),
    ),
  ).toContain('0.8');
  await act(async () =>
    root!.render(<PoolCandleChart snapshot={sol} projectId={project.id} />),
  );
  await click('Restore chart drawings');
  expect(container.textContent).toContain('No drawings saved');
  expect(
    container.querySelector('[aria-label="Price guide SOL 0.8"]'),
  ).toBeNull();
  await act(async () =>
    root!.render(<PoolCandleChart snapshot={usd} projectId={project.id} />),
  );
  await click('Restore chart drawings');
  expect(
    container.querySelector('[aria-label="Price guide $0.8"]'),
  ).not.toBeNull();
});
it('requests the selected denomination and uses it for manual refresh without accepting an obsolete currency response', async () => {
  const pending: {
    url: string;
    init?: RequestInit;
    resolve: (r: Response) => void;
  }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) =>
          pending.push({ url, init, resolve }),
        ),
    ),
  );
  await mount(
    <ImportedPoolCandles
      project={project}
      pool={usd.pool}
      feedRunning={false}
    />,
  );
  await act(async () =>
    pending[0].resolve(
      Response.json({
        id: project.id,
        revision: 1,
        executionAllowed: false,
        observations: [usd],
      }),
    ),
  );
  const selector = container.querySelector(
    'select[aria-label="Candle price currency"]',
  ) as unknown as HTMLSelectElement;
  await act(async () => {
    selector.value = 'sol';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(
    new URL(pending[1].url, 'http://test').searchParams.get('currency'),
  ).toBe('sol');
  await act(async () =>
    pending[1].resolve(
      Response.json({
        id: project.id,
        revision: 1,
        executionAllowed: false,
        observations: [sol],
      }),
    ),
  );
  expect(
    container.querySelector('svg[aria-label*="SOL price"]'),
  ).not.toBeNull();
  await click('Refresh pool candles');
  expect(JSON.parse(pending[2].init!.body as string).currency).toBe('sol');
  await act(async () =>
    pending[2].resolve(
      Response.json({
        id: project.id,
        revision: 1,
        executionAllowed: false,
        observations: [usd],
      }),
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Candle context mismatch',
  );
  expect(
    container.querySelector('svg[aria-label*="SOL price"]'),
  ).not.toBeNull();
});
