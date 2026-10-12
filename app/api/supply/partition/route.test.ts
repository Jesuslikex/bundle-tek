import { describe, expect, it, vi } from 'vitest';
const { observe } = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('@/lib/supply-partition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supply-partition')>()),
  observeSupplyPartition: observe,
}));
import { POST } from './route';
const mint = '11111111111111111111111111111111';
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://bundle.test/api/supply/partition', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
describe('classified supply endpoint', () => {
  it('validates scope before reads', async () => {
    observe.mockClear();
    expect((await POST(req({ mint, wallets: [] }))).status).toBe(400);
    expect(
      (
        await POST(
          req({ mint, wallets: [] }, { origin: 'https://outside.test' }),
        )
      ).status,
    ).toBe(403);
    expect(observe).not.toHaveBeenCalled();
  });
  it('returns a no-store snapshot and omits provider error details on failure', async () => {
    const body = { mint, wallets: [{ address: mint, group: 'team' }] };
    observe.mockResolvedValueOnce({ mint });
    const response = await POST(req(body));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ snapshot: { mint } });
    observe.mockRejectedValueOnce(
      new Error('https://secret-provider?api-key=secret'),
    );
    const failure = await POST(req(body));
    expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain('secret');
  });
});
