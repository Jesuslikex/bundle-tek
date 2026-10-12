import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: null as null | { userId: string },
  inspect: vi.fn(),
  read: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/lib/token-import', async (original) => ({
  ...(await original<typeof import('@/lib/token-import')>()),
  inspectToken: mocks.inspect,
}));
vi.mock('@/lib/token-linked-metadata', async (original) => ({
  ...(await original<typeof import('@/lib/token-linked-metadata')>()),
  readLinkedTokenMetadata: mocks.read,
}));
import { GET } from './route';
const mint = 'So11111111111111111111111111111111111111112';
const uri =
  'https://raw.githubusercontent.com/owner/repository/main/token.json';
const request = (url = uri, chain = 'Solana') =>
  new Request(
    `http://localhost/api/tokens/linked-metadata?${new URLSearchParams({ chain, address: mint, uri: url })}`,
  );
it('authenticates and validates before provider access, rechecks the on-chain URI, and hides provider details', async () => {
  mocks.inspect.mockReset();
  mocks.read.mockReset();
  mocks.user = null;
  expect((await GET(request())).status).toBe(401);
  mocks.user = { userId: 'owner' };
  expect((await GET(request('http://127.0.0.1/internal'))).status).toBe(400);
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.inspect.mockResolvedValue({
    chain: 'Solana',
    address: mint,
    metadataUri: uri + '.changed',
  });
  expect((await GET(request())).status).toBe(409);
  expect(mocks.read).not.toHaveBeenCalled();
  const token = { chain: 'Solana', address: mint, metadataUri: uri };
  mocks.inspect.mockResolvedValue(token);
  mocks.read.mockResolvedValue({ fields: { description: 'Test' }, uri });
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    token,
    metadata: { fields: { description: 'Test' } },
  });
  mocks.read.mockRejectedValue(new Error('sensitive provider detail'));
  const failed = await GET(request());
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain('sensitive provider detail');
});
