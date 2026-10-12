import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: null as null | { userId: string },
  inspect: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/lib/token-import', async (original) => ({
  ...(await original<typeof import('@/lib/token-import')>()),
  inspectToken: mocks.inspect,
}));
import { GET } from './route';
it('requires identity, validates before RPC and reports provider failures without saving', async () => {
  mocks.user = null;
  expect(
    (await GET(new Request('http://localhost/api/tokens/inspect'))).status,
  ).toBe(401);
  mocks.user = { userId: 'owner' };
  expect(
    (
      await GET(
        new Request(
          'http://localhost/api/tokens/inspect?chain=Solana&address=no',
        ),
      )
    ).status,
  ).toBe(400);
  expect(mocks.inspect).not.toHaveBeenCalled();
  mocks.inspect.mockRejectedValueOnce(new Error('provider unavailable'));
  expect(
    (
      await GET(
        new Request(
          'http://localhost/api/tokens/inspect?chain=Solana&address=So11111111111111111111111111111111111111112',
        ),
      )
    ).status,
  ).toBe(502);
});
