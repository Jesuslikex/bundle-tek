import { expect, it, vi } from 'vitest';
import { GET } from './route';
it('rejects invalid addresses with a no-store 400 response', async () => {
 const response = await GET(new Request('https://local.test/api/robinhood/token?address=bad'));
 expect(response.status).toBe(400);
 expect(response.headers.get('cache-control')).toBe('no-store');
});

it('does not reflect internal transport exceptions', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('secret internal transport exception'); }));
 try {
 const response = await GET(new Request('https://local.test/api/robinhood/token?address=0xa114f757fae463fb737ef88bbafc6c3f502c430d'));
 expect(response.status).toBe(502);
 expect(JSON.stringify(await response.json())).not.toContain('secret internal');
 } finally { vi.unstubAllGlobals(); }
});
