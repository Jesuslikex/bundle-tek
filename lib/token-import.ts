import bs58 from 'bs58';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { inspectEvmTokenIdentity } from './evm-token-identity';
import { EVM_NETWORKS } from './evm-network';
import { decodeToken2022Identity } from './token-2022-identity';

import { validateTokenSource, type TokenSource } from './token-source';
export { validateTokenSource, type TokenSource } from './token-source';
export type ImportedToken = TokenSource & {
  name: string;
  symbol: string;
  decimals: number;
  totalSupplyRaw: string;
  metadataUri: string;
  observedAt: string;
  source: string;
  blockNumber?: number;
  blockHash?: string;
  contextSlot?: number;
  metadataKind?: 'Metaplex' | 'Token-2022' | 'ERC-20';
  tokenProgram?: string;
};
export const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
];
export const TOKEN_READ_RPC = 'https://solana-rpc.publicnode.com';

// Decode the bounded Borsh prefix only: discriminator, update authority, mint, name, symbol, URI.
export function decodeMetaplexIdentity(encoded: string, mint: string) {
  if (encoded.length > 4096 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error('Unsupported metadata encoding.');
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (
    bytes.length < 77 ||
    bytes[0] !== 4 ||
    bs58.encode(bytes.slice(33, 65)) !== mint
  )
    throw new Error('Metadata mint mismatch.');
  let offset = 65;
  const view = new DataView(bytes.buffer);
  function text(max: number) {
    if (offset + 4 > bytes.length) throw new Error('Truncated token metadata.');
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > max || offset + length > bytes.length)
      throw new Error('Invalid token metadata length.');
    const value = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.slice(offset, offset + length),
    );
    offset += length;
    let clean = value;
    while (clean.endsWith(String.fromCharCode(0))) clean = clean.slice(0, -1);
    for (const c of clean) {
      if (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
        throw new Error('Invalid token metadata text.');
    }
    return clean.trim();
  }
  return { name: text(32), symbol: text(10), metadataUri: text(200) };
}

async function boundedJson(response: Response) {
  if (!response.ok)
    throw new Error('Public RPC unavailable or rate-limited. Try again later.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty RPC response.');
  let text = '';
  let size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 262144) {
        await reader.cancel();
        throw new Error('Token response exceeds the inspection limit.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text + decoder.decode());
}

export async function inspectToken(
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<ImportedToken> {
  const token = validateTokenSource(input);
  if (token.chain !== 'Solana') {
    const result = await inspectEvmTokenIdentity(token, fetcher);
    return {
      ...token,
      name: result.name,
      symbol: result.symbol,
      decimals: result.decimals,
      totalSupplyRaw: result.totalSupplyRaw,
      metadataUri: '',
      source: EVM_NETWORKS[token.chain].endpoint,
      observedAt: result.observedAt,
      blockNumber: result.blockNumber,
      blockHash: result.blockHash,
      metadataKind: 'ERC-20',
    };
  }
  const signal = AbortSignal.timeout(12000);
  async function rpc(params: unknown[]) {
    const envelope = await boundedJson(
      await fetcher(TOKEN_READ_RPC, {
        method: 'POST',
        redirect: 'manual',
        cache: 'no-store',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params,
        }),
      }),
    );
    if (
      envelope.error ||
      !Number.isSafeInteger(envelope.result?.context?.slot) ||
      envelope.result.context.slot < 0
    )
      throw new Error('Invalid RPC token response.');
    return envelope.result;
  }
  const mint = await rpc([
    token.address,
    { commitment: 'confirmed', encoding: 'jsonParsed' },
  ]);
  const info = mint.value?.data?.parsed;
  if (
    !TOKEN_PROGRAMS.includes(mint.value?.owner) ||
    mint.value.executable !== false ||
    info?.type !== 'mint' ||
    info.info?.isInitialized !== true
  )
    throw new Error('This address is not an initialized token mint.');
  const { decimals, supply } = info.info;
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    typeof supply !== 'string' ||
    !/^[0-9]{1,20}$/.test(supply) ||
    BigInt(supply) > 18446744073709551615n
  )
    throw new Error('Invalid token supply or decimals.');
  if (mint.value.owner === TOKEN_PROGRAMS[1]) {
    const embedded = decodeToken2022Identity(
      info.info.extensions,
      token.address,
    );
    if (embedded)
      return {
        ...token,
        ...embedded,
        decimals,
        totalSupplyRaw: supply,
        contextSlot: mint.context.slot,
        metadataKind: 'Token-2022',
        tokenProgram: mint.value.owner,
        source: TOKEN_READ_RPC,
        observedAt: new Date().toISOString(),
      };
  }
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(METADATA_PROGRAM),
    seeds: [
      'metadata',
      bs58.decode(METADATA_PROGRAM),
      bs58.decode(token.address),
    ],
  });
  const metadata = await rpc([
    pda,
    {
      commitment: 'confirmed',
      encoding: 'base64',
      minContextSlot: mint.context.slot,
    },
  ]);
  if (
    metadata.context.slot < mint.context.slot ||
    metadata.context.slot - mint.context.slot > 32
  )
    throw new Error('Token snapshot crossed too many slots. Try again.');
  if (
    !metadata.value ||
    metadata.value.owner !== METADATA_PROGRAM ||
    metadata.value.executable !== false ||
    !Array.isArray(metadata.value.data) ||
    metadata.value.data[1] !== 'base64' ||
    typeof metadata.value.data[0] !== 'string'
  )
    throw new Error(
      'Identity unavailable. Use a mint with Metaplex metadata or linked Token-2022 metadata stored on the mint.',
    );
  const identity = decodeMetaplexIdentity(
    metadata.value.data[0],
    token.address,
  );
  if (!identity.name || !identity.symbol)
    throw new Error('Token name or symbol is unavailable.');
  return {
    ...token,
    ...identity,
    decimals,
    totalSupplyRaw: supply,
    contextSlot: metadata.context.slot,
    metadataKind: 'Metaplex',
    tokenProgram: mint.value.owner,
    source: TOKEN_READ_RPC,
    observedAt: new Date().toISOString(),
  };
}
