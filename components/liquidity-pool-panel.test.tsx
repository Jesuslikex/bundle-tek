import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { LiquidityPoolPanel } from './liquidity-pool-panel';
vi.stubGlobal('React', React);

it('asks for a token before any read or transaction', () => {
  const html = renderToStaticMarkup(<LiquidityPoolPanel />);
  expect(html).toContain('Review pool');
  expect(html).toContain('confirm every transaction');
  expect(html).not.toContain('Remove all liquidity');
});
