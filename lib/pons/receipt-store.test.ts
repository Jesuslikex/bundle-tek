import { it, expect } from 'vitest';
import { PonsStore } from './store';
import { sqliteD1, sample } from './testing';
import { validateIntent } from './intent';
it('CAS persists matched receipt lifecycle and forbids stale resurrection and re-simulation', async () => {
  const s = new PonsStore(sqliteD1());
  await s.ensure();
  const j = await s.create('a', 'receipt-key', validateIntent(sample));
  const c = await s.claim('a', j.id, 0);
  await s.finish('a', j.id, c.revision, c.lease_token!, {
    ok: true,
    unsignedTransaction: { nonce: 8 },
  });
  const p = await s.recordReceipt('a', j.id, 2, 'confirmed', {
    ok: true,
    receipt: { txHash: '0x123' },
  });
  expect(p.state).toBe('confirmed');
  await expect(s.claim('a', j.id, p.revision)).rejects.toMatchObject({
    status: 409,
  });
  await s.recordReceipt('a', j.id, p.revision, 'reorged', {
    ok: true,
    receipt: { txHash: '0x123' },
  });
  await expect(
    s.recordReceipt('a', j.id, p.revision, 'confirmed', { ok: true }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await s.get('a', j.id)).state).toBe('reorged');
  expect((await s.events('a', j.id)).length).toBe(5);
});
