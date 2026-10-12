import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { SupplyDistributionSummary } from './supply-distribution-summary';
import { supplyFixture, supplyWallet } from '../test/supply-history-fixture';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { percentOfSupply } from '@/lib/supply-analysis';
vi.stubGlobal('React', React);

it('shows saved coverage, all disjoint groups and scoped external ranking', () => {
  const html = renderToStaticMarkup(
    <SupplyDistributionSummary snapshot={supplyFixture()} />,
  );
  expect(html).toContain('Unobserved supply');
  expect(html).toContain('covers 2 selected wallets');
  expect(html).toContain('not a global holder ranking');
  expect(html).toContain('Watched external wallets (1)');
  expect(html).toContain(supplyWallet(2));
  expect(html).not.toContain(supplyWallet(1));
  expect(html).toContain('70.0000%');
});

it('preserves exact ranking above safe Number precision and closes the full supply bar', () => {
  const snapshot = supplyFixture();
  const total = 18446744073709551615n;
  const smaller = 9007199254740992n,
    larger = smaller + 1n;
  snapshot.totalSupplyRaw = total.toString();
  snapshot.totalSupply = formatNativeBalance(
    total.toString(),
    snapshot.decimals,
  );
  snapshot.wallets = [smaller, larger].map((raw, i) => ({
    ...snapshot.wallets[i],
    group: 'external' as const,
    raw: raw.toString(),
    amount: formatNativeBalance(raw.toString(), snapshot.decimals),
    supplyPercent: percentOfSupply(raw, total),
  }));
  for (const [group, raw] of Object.entries({
    team: 0n,
    external: smaller + larger,
    pool: 0n,
    unclassified: total - smaller - larger,
    outsideTeam: total,
  })) {
    snapshot.parts[group as keyof typeof snapshot.parts] = {
      raw: raw.toString(),
      amount: formatNativeBalance(raw.toString(), snapshot.decimals),
      supplyPercent: percentOfSupply(raw, total),
    };
  }
  const html = renderToStaticMarkup(
    <SupplyDistributionSummary snapshot={snapshot} />,
  );
  expect(html.indexOf(supplyWallet(2))).toBeLessThan(
    html.indexOf(supplyWallet(1)),
  );
  const rects = [
    ...html.matchAll(/<rect[^>]*x="([\d.]+)"[^>]*width="([\d.]+)"/g),
  ];
  expect(rects).toHaveLength(4);
  expect(Number(rects.at(-1)![1]) + Number(rects.at(-1)![2])).toBe(1000);
  expect(html).not.toMatch(/NaN|Infinity/);
});

it('explains an empty external watchlist without inventing holders', () => {
  const snapshot = supplyFixture(0, {
    mint: supplyWallet(9),
    wallets: [{ address: supplyWallet(1), group: 'team' }],
  });
  const html = renderToStaticMarkup(
    <SupplyDistributionSummary snapshot={snapshot} />,
  );
  expect(html).toContain('No external wallets were selected');
  expect(html).not.toContain('<ol');
});
