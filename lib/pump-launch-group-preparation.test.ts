import { afterEach, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { pumpOwnedGroupFixture } from '../test/pump-owned-group-fixture';
import { preflightOwnedPumpCreate } from './owned-pump-preflight';
import { prepareOwnedPumpHolderPacket } from './pump-holder-preparation';
import type { PumpLaunchRpc } from './pump-launch-simulation';
vi.mock('./owned-pump-preflight', async (original) => ({
  ...(await original<typeof import('./owned-pump-preflight')>()),
  preflightOwnedPumpCreate: vi.fn(),
}));
const clients: Client[] = [],
  mocked = vi.mocked(preflightOwnedPumpCreate);
afterEach(() => {
  mocked.mockReset();
  for (const client of clients.splice(0)) client.close();
});
const fixture = () => pumpOwnedGroupFixture(mocked, clients);
it('derives complete saved targets and collects an owned multi-packet group without signing permission', async () => {
  const f = await fixture(),
    result = await f.run();
  expect(result.group.manifestSha256).toBe(f.group.manifestSha256);
  expect(result.targets.items).toHaveLength(18);
  expect(result.targets.items[2].participates).toBe(false);
  expect(result).toMatchObject({
    fundingValidated: true,
    settlementValidated: true,
    durableReviewRequired: true,
    reservationRequired: true,
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
  });
  expect(
    f.calls.filter((call) => call.method === 'simulateBundle'),
  ).toHaveLength(1);
}, 15000);
it('rejects another owner and per-slot overrides before provider reads', async () => {
  const f = await fixture();
  await expect(f.run(f.rpc, 'bob')).rejects.toThrow('Owned project');
  await expect(
    f.run(f.rpc, 'alice', {
      ...f.terms,
      holderLimits: [...f.terms.holderLimits].reverse(),
    }),
  ).rejects.toThrow('slot in order');
  expect(f.calls).toHaveLength(0);
}, 15000);
it('rejects a holder revision changed during funding before replay', async () => {
  const f = await fixture();
  let changed = false;
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    if (!changed && method === 'getFeeForMessage') {
      changed = true;
      await f.client.execute({
        sql: 'UPDATE workspace_wallets SET revision=2 WHERE address=?',
        args: [f.input.holders[0].address],
      });
    }
    return f.rpc(method, params, signal);
  };
  await expect(f.run(rpc)).rejects.toThrow('owned wallet revision');
  expect(
    f.calls.filter((call) => call.method === 'simulateBundle'),
  ).toHaveLength(0);
}, 15000);
it('rejects a revoked ownership proof during economic collection', async () => {
  const f = await fixture();
  let changed = false;
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    if (!changed && method === 'getMinimumBalanceForRentExemption') {
      changed = true;
      await f.client.execute({
        sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
        args: [f.input.holders[0].address],
      });
    }
    return f.rpc(method, params, signal);
  };
  await expect(f.run(rpc)).rejects.toThrow('owned wallet revision');
}, 15000);
it('rejects same-revision project content changes during funding', async () => {
  const f = await fixture();
  let changed = false;
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    if (!changed && method === 'getFeeForMessage') {
      changed = true;
      await f.client.execute({
        sql: 'UPDATE workspace_projects SET document=? WHERE id=?',
        args: [
          JSON.stringify({
            ...f.document,
            identity: { ...f.document.identity, description: 'changed' },
          }),
          'group',
        ],
      });
    }
    return f.rpc(method, params, signal);
  };
  await expect(f.run(rpc)).rejects.toThrow('context changed');
}, 15000);
it('preserves the original one-packet owned preparation contract after context extraction', async () => {
  const f = await fixture();
  const document = {
    ...f.document,
    plan: {
      ...f.document.plan,
      holderCount: 3,
      holdersBuy: 0.3,
      holdersDistribution: {
        ...f.document.plan.holdersDistribution!,
        weights: ['2', '1', '0'],
      },
    },
    options: {
      ...f.document.options,
      wallets: {
        ...f.document.options.wallets!,
        recipients: f.document.options.wallets!.recipients.slice(0, 3),
      },
    },
  };
  await f.client.execute({
    sql: 'UPDATE workspace_projects SET document=? WHERE id=?',
    args: [JSON.stringify(document), 'group'],
  });
  const capture = vi.fn();
  const result = await prepareOwnedPumpHolderPacket(
    f.db,
    'alice',
    { ...f.terms, holderLimits: f.terms.holderLimits.slice(0, 3) },
    new AbortController().signal,
    { rpc: f.rpc, captureInput: capture },
  );
  expect(result).toMatchObject({
    format: 'pump-owned-holder-packet-v1',
    fundingValidated: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(result.packet.requiredSigners).toHaveLength(4);
  expect(result).not.toHaveProperty('input');
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture.mock.calls[0][0].holders).toHaveLength(3);
  expect(f.calls).toHaveLength(0);
}, 15000);
