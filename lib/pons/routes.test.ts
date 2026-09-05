import { POST as receipt } from '@/app/api/pons/jobs/[id]/receipt/route';
import { it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: vi.fn(async () => ({
    userId: 'route-owner',
    email: 'a@test',
  })),
}));
import { POST } from '@/app/api/pons/jobs/route';
import { GET } from '@/app/api/pons/jobs/[id]/route';
import { POST as simulate } from '@/app/api/pons/jobs/[id]/simulate/route';
import { POST as handoff } from '@/app/api/pons/jobs/[id]/handoff/route';
import { sqliteD1 } from './testing';
import { sample } from './testing';
it('wires authenticated D1 routes and keeps deployment default locked', async () => {
  const e = env as unknown as Record<string, unknown>;
  e.DB = sqliteD1();
  delete e.PONS_BACKEND_ENABLED;
  expect(
    (
      await receipt(new Request('https://app.test', { method: 'POST' }), {
        params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }),
      })
    ).status,
  ).toBe(423);
  expect(
    (
      await POST(
        new Request('https://app.test/api/pons/jobs', { method: 'POST' }),
      )
    ).status,
  ).toBe(423);
  e.PONS_BACKEND_ENABLED = 'true';
  try {
    const response = await POST(
      new Request('https://app.test/api/pons/jobs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'route-key',
        },
        body: JSON.stringify(sample),
      }),
    );
    expect(response.status).toBe(201);
    const { job } = (await response.json()) as { job: { id: string } };
    expect(
      (
        await GET(new Request('https://app.test'), {
          params: Promise.resolve({ id: job.id }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await handoff(
          new Request('https://app.test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"revision":0}',
          }),
          { params: Promise.resolve({ id: job.id }) },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await simulate(
          new Request('https://app.test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ revision: 99 }),
          }),
          { params: Promise.resolve({ id: job.id }) },
        )
      ).status,
    ).toBe(409);
  } finally {
    delete e.PONS_BACKEND_ENABLED;
    delete e.DB;
  }
});
