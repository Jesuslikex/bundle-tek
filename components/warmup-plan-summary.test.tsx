import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { buildWarmupPlan } from '../lib/wallet-warmup';
import { WarmupPlanSummary } from './warmup-plan-summary';
vi.stubGlobal('React', React);
const input = {
  chain: 'Base',
  addresses: [
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
  ],
  tokens: ['0x4200000000000000000000000000000000000006'],
  amount: '0.000000000000000001',
  feeReserve: '0.000000000000000002',
  cycles: 3,
  intervalMinutes: 60,
  startAt: '2026-10-12T01:00:00Z',
};
it('retains subunit budget precision and the complete staggered buy-to-sell window', () => {
  const plan = buildWarmupPlan(input, Date.parse('2026-10-12T00:00:00Z'));
  const html = renderToStaticMarkup(<WarmupPlanSummary plan={plan} />);
  expect(html).toContain('0.000000000000000005');
  expect(html).toContain('0.00000000000000001');
  expect(html).toContain('2h 37m 30s');
  expect(html).toContain('dateTime="2026-10-12T03:37:30.000Z"');
  expect(html).toContain('Review only');
  expect(html).toContain('separate review and approval');
  expect(html).toContain('actual fees are unknown');
});
it('does not multiply elapsed time by wallet count or discard a single-cycle sell interval', () => {
  const plan = buildWarmupPlan(
    {
      ...input,
      addresses: [input.addresses[0]],
      cycles: 1,
      intervalMinutes: 15,
    },
    Date.parse('2026-10-12T00:00:00Z'),
  );
  const html = renderToStaticMarkup(<WarmupPlanSummary plan={plan} />);
  expect(html).toContain('7m 30s');
  expect(html).toContain('Sell proceeds are not reused');
});
