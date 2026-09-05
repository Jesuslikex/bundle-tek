import { it, expect, vi } from 'vitest';
import { handlePons } from './api';
import { PonsStore } from './store';
import { sqliteD1, sample } from './testing';
import { validateIntent } from './intent';
it('revalidates exact stored economics, fee and calldata at unsigned handoff and invalidates changed terms', async () => {
  const s = new PonsStore(sqliteD1());
  await s.ensure();
  const j = await s.create('a', 'handoff-key', validateIntent(sample));
  const c = await s.claim('a', j.id, 0);
  const original = {
    ok: true,
    expectedEconomics: 'pin',
    launchFeeWei: '7',
    expiresAt: Date.now() + 120000,
    unsignedTransaction: {
      chainId: 4663,
      from: sample.wallet,
      to: sample.wallet,
      value: '8',
      data: '0x1234',
    },
  };
  await s.finish('a', j.id, c.revision, c.lease_token!, original);
  const changed = {
    ...original,
    launchFeeWei: '9',
    unsignedTransaction: { ...original.unsignedTransaction, value: '10' },
  };
  const res = await handlePons(
    new Request('https://app.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 2 }),
    }),
    'handoff',
    j.id,
    {
      owner: async () => 'a',
      enabled: true,
      store: s,
      simulate: vi.fn(async () => changed),
    },
  );
  expect(res.status).toBe(200);
  const current = await s.get('a', j.id);
  expect(current.state).toBe('simulation_failed');
  expect(JSON.parse(current.result!).error).toBe('TERMS_CHANGED_RESIMULATE');
});

it('invalidates changed gas price rather than silently changing the signed fee envelope', async () => {
  const s = new PonsStore(sqliteD1());
  await s.ensure();
  const j = await s.create('a', 'fee-handoff', validateIntent(sample));
  const c = await s.claim('a', j.id, 0);
  const original = {
    ok: true,
    expectedEconomics: 'pin',
    launchFeeWei: '7',
    expiresAt: Date.now() + 120000,
    unsignedTransaction: {
      chainId: 4663,
      from: sample.wallet,
      to: sample.wallet,
      value: '8',
      data: '0x1234',
      gas: '600000',
      gasPrice: '100',
    },
  };
  await s.finish('a', j.id, c.revision, c.lease_token!, original);
  await handlePons(
    new Request('https://app.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"revision":2}',
    }),
    'handoff',
    j.id,
    {
      owner: async () => 'a',
      enabled: true,
      store: s,
      simulate: async () => ({
        ...original,
        unsignedTransaction: {
          ...original.unsignedTransaction,
          gasPrice: '101',
        },
      }),
    },
  );
  expect((await s.get('a', j.id)).state).toBe('simulation_failed');
});
