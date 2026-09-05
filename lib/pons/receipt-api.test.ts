import { it, expect, vi } from 'vitest';
import { handlePons } from './api';
import { PonsStore } from './store';
import { sqliteD1, sample } from './testing';
import { validateIntent } from './intent';
it('accepts only owner-scoped exact hash proof, CAS saves observation, denies raw signed payload', async () => {
  const s = new PonsStore(sqliteD1());
  await s.ensure();
  const j = await s.create('a', 'receipt-api', validateIntent(sample));
  const c = await s.claim('a', j.id, 0);
  await s.finish('a', j.id, c.revision, c.lease_token!, {
    ok: true,
    unsignedTransaction: { nonce: 8 },
  });
  const hash = '0x' + 'ab'.repeat(32);
  const observe = vi.fn(async () => ({
    state: 'submitted' as const,
    receipt: {
      txHash: hash as `0x${string}`,
      confirmations: '0',
      status: 'pending',
      observedAt: 1,
      requiredConfirmations: '12',
      finality: 'not asserted' as const,
    },
  }));
  const deps = {
    owner: async () => 'a',
    enabled: true,
    store: s,
    simulate: vi.fn(async () => ({ ok: true })),
    observe,
  };
  const req = (body: unknown) =>
    new Request('https://app.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect(
    (
      await handlePons(
        req({ revision: 2, rawTransaction: '0x123' }),
        'receipt',
        j.id,
        deps,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handlePons(req({ revision: 2, txHash: hash }), 'receipt', j.id, {
        ...deps,
        owner: async () => 'b',
      })
    ).status,
  ).toBe(404);
  expect(observe).not.toHaveBeenCalled();
  expect(
    (
      await handlePons(
        req({ revision: 2, txHash: hash }),
        'receipt',
        j.id,
        deps,
      )
    ).status,
  ).toBe(200);
  expect((await s.get('a', j.id)).state).toBe('submitted');
  const view = await handlePons(
    new Request('https://app.test'),
    'get',
    j.id,
    deps,
  );
  const shown = (await view.json()) as {
    job: { handoff: { usable: boolean } };
  };
  expect(shown.job.handoff.usable).toBe(false);
  expect(
    (
      await handlePons(
        req({ revision: 2, txHash: hash }),
        'receipt',
        j.id,
        deps,
      )
    ).status,
  ).toBe(409);
});
