import { expect, it, vi } from 'vitest';
import {
  decodeLinkedMetadata,
  metadataGateway,
  publicMetadataLink,
  readLinkedTokenMetadata,
  validateCloneMetadataProof,
} from './token-linked-metadata';
import {
  validateProjectDocument,
  projectChanges,
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
} from './workspace-project';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import type { ImportedToken } from './token-import';
const uri =
  'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/token.json';
const token: ImportedToken = {
  chain: 'Solana',
  address: 'So11111111111111111111111111111111111111112',
  name: 'Token',
  symbol: 'TOK',
  decimals: 9,
  totalSupplyRaw: '100',
  metadataUri: uri,
  observedAt: '2026-10-10T12:00:00.000Z',
  source: 'solana-rpc.publicnode.com',
};
it('routes only fixed storage gateways and rejects alternate schemes, redirects targets and network-local hosts', () => {
  expect(metadataGateway('ipfs://Qm' + 'a'.repeat(44) + '/token.json')).toBe(
    'https://gateway.pinata.cloud/ipfs/Qm' + 'a'.repeat(44) + '/token.json',
  );
  expect(metadataGateway('ar://' + 'a'.repeat(43))).toBe(
    'https://arweave.net/' + 'a'.repeat(43),
  );
  expect(metadataGateway(uri)).toBe(uri);
  for (const value of [
    'https://localhost/token.json',
    'https://127.0.0.1/x',
    'http://arweave.net/' + 'a'.repeat(43),
    'https://arweave.net.evil.test/' + 'a'.repeat(43),
    'https://user:pass@arweave.net/' + 'a'.repeat(43),
    uri + '?secret=1',
    uri + '#fragment',
    'https://raw.githubusercontent.com:444/a/b/c/d',
    'ipfs://bad',
    'data:application/json,{}',
    'https://ipfs.io/ipfs/Qm' + 'a'.repeat(44) + '/../../admin',
  ])
    expect(() => metadataGateway(value)).toThrow();
});
it('decodes selected draft fields while keeping on-chain identity authoritative and omitting invalid optional fields', () => {
  expect(
    decodeLinkedMetadata(
      {
        name: 'Token',
        symbol: 'TOK',
        description: ' About\nToken ',
        image: 'ipfs://Qm' + 'a'.repeat(44) + '/image.png',
        extensions: {
          website: 'https://token.example',
          twitter: 'https://x.com/token',
          telegram: 'https://t.me/token',
        },
      },
      token,
    ),
  ).toMatchObject({
    fields: {
      description: 'About\nToken',
      artworkUrl:
        'https://gateway.pinata.cloud/ipfs/Qm' + 'a'.repeat(44) + '/image.png',
      website: 'https://token.example/',
      twitter: 'https://x.com/token',
      telegram: 'https://t.me/token',
    },
    warnings: [],
  });
  expect(() => decodeLinkedMetadata({ name: 'Another token' }, token)).toThrow(
    'identity mismatch',
  );
  expect(() => decodeLinkedMetadata([], token)).toThrow();
  const bad = decodeLinkedMetadata(
    {
      description: 'x'.repeat(281),
      image: 'javascript:alert(1)',
      twitter: 'https://evil.test/token',
      telegram: 'https://127.0.0.1/token',
    },
    token,
  );
  expect(bad.fields).toEqual({});
  expect(bad.warnings).toHaveLength(4);
  expect(() =>
    publicMetadataLink('ipfs://Qm' + 'a'.repeat(44), 'twitter'),
  ).toThrow('X link');
  expect(() =>
    publicMetadataLink('https://ipfs.io/ipfs/Qm' + 'a'.repeat(44), 'telegram'),
  ).toThrow('Telegram link');
  for (const link of [
    'https://localhost/a',
    'https://foo.local/a',
    'https://[::1]/x',
    'https://127.1/x',
    'https://user:pass@foo.test/x',
    'http://foo.test/x',
    'https://foo.test/\u0000',
  ])
    expect(() => publicMetadataLink(link)).toThrow();
});
it('reads a bounded credential-free document and saves its exact digest without following redirects or fetching artwork', async () => {
  const raw = JSON.stringify({
    description: 'A token',
    image: 'https://image.example/token.png',
  });
  const fetcher = vi.fn<typeof fetch>(async () => new Response(raw));
  const metadata = await readLinkedTokenMetadata(
    token,
    AbortSignal.timeout(1000),
    fetcher,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    uri,
    expect.objectContaining({
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
    }),
  );
  expect(metadata.sha256).toBe(
    Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)),
    ).toString('hex'),
  );
  expect(metadata.fields.description).toBe('A token');
  const proof = validateCloneMetadataProof(metadata);
  const before = validateProjectDocument({
    plan: { ...DEFAULT_LAUNCH_PLAN, tokenName: 'Token', ticker: 'TOK' },
    identity: EMPTY_IDENTITY,
    options: DEFAULT_VENUE_OPTIONS,
  });
  const after = validateProjectDocument({
    ...before,
    plan: { ...before.plan, description: metadata.fields.description },
    identity: {
      ...before.identity,
      artworkUrl: metadata.fields.artworkUrl,
      clonedFrom: { chain: token.chain, address: token.address },
      clonedMetadata: proof,
    },
  });
  expect(after.identity.clonedMetadata).toEqual(proof);
  expect(projectChanges(before, after)).toContain('cloned metadata source');
  expect(() =>
    validateProjectDocument({
      ...after,
      identity: { ...after.identity, clonedFrom: undefined },
    }),
  ).toThrow();
  expect(() =>
    validateCloneMetadataProof({ ...proof, sourceUrl: 'https://evil.test' }),
  ).toThrow();
  expect(() =>
    validateCloneMetadataProof({ ...proof, sha256: 'invalid' }),
  ).toThrow();
  await expect(
    readLinkedTokenMetadata(
      token,
      AbortSignal.timeout(1000),
      async () =>
        new Response('', {
          status: 302,
          headers: { location: 'http://127.0.0.1/' },
        }),
    ),
  ).rejects.toThrow();
  await expect(
    readLinkedTokenMetadata(
      token,
      AbortSignal.timeout(1000),
      async () => new Response('x'.repeat(131073)),
    ),
  ).rejects.toThrow('too large');
  await expect(
    readLinkedTokenMetadata(
      token,
      AbortSignal.timeout(1000),
      async () => new Response(new Uint8Array([255])),
    ),
  ).rejects.toThrow();
});
