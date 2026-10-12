import { expect, it, vi } from 'vitest';
import { decodeToken2022Identity } from './token-2022-identity';
import { inspectToken, TOKEN_READ_RPC } from './token-import';
const mint = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
function extensions() {
  return [
    {
      extension: 'metadataPointer',
      state: { metadataAddress: mint, authority: null },
    },
    {
      extension: 'tokenMetadata',
      state: {
        mint,
        name: 'PayPal USD',
        symbol: 'PYUSD',
        uri: 'https://example.com/metadata.json',
        additionalMetadata: [['description', 'ignored']],
      },
    },
  ];
}
it('reads linked mint-side Token-2022 identity and exact supply in one RPC snapshot', async () => {
  const fetcher = vi.fn(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(url).toBe(TOKEN_READ_RPC);
      expect(JSON.parse(init!.body as string)).toMatchObject({
        method: 'getAccountInfo',
        params: [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      });
      return Response.json({
        result: {
          context: { slot: 1234 },
          value: {
            owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
            executable: false,
            data: {
              parsed: {
                type: 'mint',
                info: {
                  isInitialized: true,
                  decimals: 6,
                  supply: '18446744073709551615',
                  extensions: extensions(),
                },
              },
            },
          },
        },
      });
    },
  ) as typeof fetch;
  expect(
    await inspectToken({ chain: 'Solana', address: mint }, fetcher),
  ).toMatchObject({
    name: 'PayPal USD',
    symbol: 'PYUSD',
    totalSupplyRaw: '18446744073709551615',
    decimals: 6,
    contextSlot: 1234,
    metadataKind: 'Token-2022',
    tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    metadataUri: 'https://example.com/metadata.json',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('supports Unicode metadata without silently replacing malformed text', () => {
  const values = extensions();
  values[1].state.name = 'Café 🐦';
  expect(decodeToken2022Identity(values, mint)?.name).toBe('Café 🐦');
  for (const name of [
    '\ud800',
    '\udc00',
    'bad\u0000',
    '\tName',
    'x'.repeat(257),
    'é'.repeat(129),
    ' ',
  ]) {
    values[1].state.name = name;
    expect(() => decodeToken2022Identity(values, mint)).toThrow();
  }
});
it.each([
  'mint',
  'pointer',
  'duplicate-metadata',
  'duplicate-pointer',
  'missing-pointer',
  'missing-name',
  'missing-symbol',
  'bad-uri',
  'external-pointer',
])('rejects %s instead of using conflicting identity', (kind) => {
  const values: Array<{ extension: string; state: Record<string, unknown> }> =
    extensions();
  if (kind === 'mint')
    values[1].state.mint = '11111111111111111111111111111111';
  if (kind === 'pointer') values[0].state.metadataAddress = null;
  if (kind === 'external-pointer')
    values[0].state.metadataAddress = '11111111111111111111111111111111';
  if (kind === 'duplicate-metadata') values.push(values[1]);
  if (kind === 'duplicate-pointer') values.push(values[0]);
  if (kind === 'missing-pointer') values.shift();
  if (kind === 'missing-name') delete values[1].state.name;
  if (kind === 'missing-symbol') values[1].state.symbol = '';
  if (kind === 'bad-uri') values[1].state.uri = 'x'.repeat(2049);
  expect(() => decodeToken2022Identity(values, mint)).toThrow();
});
it('leaves absent metadata for the Metaplex path and bounds extension lists', () => {
  expect(decodeToken2022Identity(undefined, mint)).toBeNull();
  expect(
    decodeToken2022Identity([{ extension: 'transferFeeConfig' }], mint),
  ).toBeNull();
  expect(() => decodeToken2022Identity({}, mint)).toThrow();
  expect(() => decodeToken2022Identity(Array(65).fill(null), mint)).toThrow();
});
