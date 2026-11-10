import { expect, it } from 'vitest';
import {
  formatUsdCompact,
  parseOverviewNetwork,
  rankByVolume,
  trenchIndex,
} from './market-overview';

const pad = (name: string, day: number | null, month: number, extra = {}) => ({
  name,
  displayName: name,
  category: 'Launchpad',
  chains: ['Solana'],
  total24h: day,
  total7d: month / 4,
  total30d: month,
  totalAllTime: month * 10,
  change_1d: 4.5,
  ...extra,
});
const body = {
  total24h: 1000,
  total7d: 6000,
  total30d: 30000,
  totalAllTime: 900000,
  change_1d: -2.5,
  protocols: [
    { name: 'Orca', category: 'Dexs', total24h: 500, total30d: 9000 },
    pad('LaunchLab', 20, 300),
    pad('pump.fun', 100, 3000),
    pad('Dead pad', null, 0),
    'junk',
    pad('', 5, 5),
  ],
};

it('keeps launchpads only, ranked by 24h volume, with network totals', () => {
  const network = parseOverviewNetwork('Solana', body)!;
  expect(network.volume).toEqual({
    '24h': 1000,
    '7d': 6000,
    '30d': 30000,
    all: 900000,
  });
  expect(network.change1d).toBe(-2.5);
  expect(network.launchpads.map((p) => p.name)).toEqual([
    'pump.fun',
    'LaunchLab',
  ]);
  expect(network.launchpads[0].volume['30d']).toBe(3000);
});
it('rejects bodies without usable totals', () => {
  expect(parseOverviewNetwork('All', null)).toBeNull();
  expect(parseOverviewNetwork('All', [])).toBeNull();
  expect(
    parseOverviewNetwork('All', { total24h: 'x', protocols: [] }),
  ).toBeNull();
  expect(
    parseOverviewNetwork('All', { total24h: -5, total30d: Number.NaN }),
  ).toBeNull();
});
it('scores an average day 50, double 100, nothing 0', () => {
  const v = (day: number, month: number) => [
    { volume: { '24h': day, '7d': null, '30d': month, all: null } },
  ];
  expect(trenchIndex(v(100, 3000))).toEqual({ score: 50, label: 'Neutral' });
  expect(trenchIndex(v(400, 3000))).toEqual({ score: 100, label: 'Euphoric' });
  expect(trenchIndex(v(0, 3000))).toEqual({ score: 0, label: 'Ded' });
  expect(trenchIndex(v(130, 3000))!.label).toBe('Hot');
  expect(trenchIndex(v(60, 3000))!.label).toBe('Cold');
  expect(trenchIndex(v(10, 0))).toBeNull();
  expect(trenchIndex([])).toBeNull();
});
it('ranks by the chosen period with unknown volumes last', () => {
  const rows = [
    { id: 'a', volume: { '24h': 1, '7d': 50, '30d': null, all: null } },
    { id: 'b', volume: { '24h': 9, '7d': 5, '30d': 4, all: null } },
  ];
  expect(rankByVolume(rows, '24h').map((r) => r.id)).toEqual(['b', 'a']);
  expect(rankByVolume(rows, '7d').map((r) => r.id)).toEqual(['a', 'b']);
  expect(rankByVolume(rows, '30d').map((r) => r.id)).toEqual(['b', 'a']);
});
it('formats compact dollars', () => {
  expect(formatUsdCompact(1487777537)).toBe('$1.49B');
  expect(formatUsdCompact(950)).toBe('$950');
  expect(formatUsdCompact(null)).toBe('—');
});
