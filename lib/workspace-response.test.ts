import { expect, it } from 'vitest';
import { readWorkspaceResponse } from './workspace-response';

const read = (response: Response) =>
  readWorkspaceResponse(response, 'Service unavailable.', 'Sign in.');

it.each([
  [401, ''],
  [401, '<html>Private proxy error</html>'],
  [500, ''],
  [502, '<html>Private proxy error</html>'],
  [503, '{"error":"Private server detail"}'],
])(
  'uses a safe message for HTTP %s without requiring JSON',
  async (status, body) => {
    await expect(read(new Response(body, { status }))).rejects.toThrow(
      status === 401 ? 'Sign in.' : 'Service unavailable.',
    );
  },
);

it.each(['', '<html>Proxy failure</html>', 'null', '[]', '42'])(
  'refuses an invalid successful response: %s',
  async (body) => {
    await expect(read(new Response(body))).rejects.toThrow(
      'Service unavailable.',
    );
  },
);

it('retains a successful JSON object for the consumer to validate', async () => {
  const body = { wallets: [], folders: [] };
  await expect(read(Response.json(body))).resolves.toEqual(body);
});
