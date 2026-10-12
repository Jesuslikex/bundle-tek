import { afterEach, expect, it, vi } from 'vitest';
import {
  requestSupplyAlertChart,
  subscribeSupplyAlertChart,
  SUPPLY_ALERT_CHART,
} from './supply-alert-chart-events';
import { supplyWallet } from '../test/supply-history-fixture';
import bs58 from 'bs58';
const request = {
  projectId: 'p',
  revision: 2,
  mint: supplyWallet(9),
  wallet: supplyWallet(1),
  from: '2026-10-11T12:00:00Z',
  to: '2026-10-11T13:00:00Z',
};
afterEach(() => vi.unstubAllGlobals());
it('admits decoded transaction times only with bounded block time, slot and full signature', () => {
  vi.stubGlobal('window', new EventTarget());
  const transaction = {
    signature: bs58.encode(new Uint8Array(64).fill(3)),
    slot: 130,
    blockTime: 1791716430,
  };
  const receive = vi.fn(() => null);
  const stop = subscribeSupplyAlertChart(request, receive);
  expect(requestSupplyAlertChart({ ...request, transaction })).toBeNull();
  expect(receive).toHaveBeenCalledWith({ ...request, transaction });
  for (const patch of [
    { signature: 'bad' },
    { slot: 0 },
    { slot: 1.5 },
    { blockTime: NaN },
    { blockTime: 0 },
    { blockTime: -1 },
    { blockTime: 8640000000001 },
  ])
    expect(
      requestSupplyAlertChart({
        ...request,
        transaction: { ...transaction, ...patch },
      }),
    ).toContain('Invalid');
  expect(receive).toHaveBeenCalledTimes(1);
  stop();
});
it('admits only the matching project revision/mint and removes the listener', () => {
  vi.stubGlobal('window', new EventTarget());
  const receive = vi.fn(() => null);
  const stop = subscribeSupplyAlertChart(request, receive);
  expect(requestSupplyAlertChart(request)).toBeNull();
  for (const foreign of [
    { ...request, projectId: 'other' },
    { ...request, revision: 1 },
    { ...request, mint: supplyWallet(8) },
  ])
    expect(requestSupplyAlertChart(foreign)).toContain('Open this token');
  expect(receive).toHaveBeenCalledTimes(1);
  stop();
  expect(requestSupplyAlertChart(request)).toContain('Open this token');
  expect(receive).toHaveBeenCalledTimes(1);
});
it('rejects malformed observation contexts and relays missing-history admission', () => {
  vi.stubGlobal('window', new EventTarget());
  const receive = vi.fn(() => 'Load relevant candles.');
  const stop = subscribeSupplyAlertChart(request, receive);
  expect(requestSupplyAlertChart(request)).toBe('Load relevant candles.');
  for (const bad of [
    { ...request, wallet: 'bad' },
    { ...request, mint: 'bad' },
    { ...request, revision: 0 },
    { ...request, from: request.to },
    { ...request, to: request.from },
    { ...request, to: 'invalid' },
  ])
    expect(requestSupplyAlertChart(bad)).toContain('Invalid');
  window.dispatchEvent(
    new CustomEvent(SUPPLY_ALERT_CHART, {
      detail: { request: { ...request, wallet: null } },
    }),
  );
  expect(receive).toHaveBeenCalledTimes(1);
  stop();
});
