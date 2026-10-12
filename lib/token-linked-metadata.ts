import type { ImportedToken } from './token-import';

export type CloneMetadataProof = {
  uri: string;
  sourceUrl: string;
  sha256: string;
  observedAt: string;
};
export type CloneMetadataFields = {
  description?: string;
  artworkUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
};
export type LinkedTokenMetadata = CloneMetadataProof & {
  fields: CloneMetadataFields;
  warnings: string[];
};
export function validateCloneMetadataProof(value: unknown): CloneMetadataProof {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid cloned metadata proof.');
  const proof = value as Record<string, unknown>;
  if (
    typeof proof.uri !== 'string' ||
    proof.sourceUrl !== metadataGateway(proof.uri) ||
    typeof proof.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proof.sha256) ||
    typeof proof.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(proof.observedAt)) ||
    new Date(proof.observedAt).toISOString() !== proof.observedAt
  )
    throw new Error('Invalid cloned metadata proof.');
  return {
    uri: proof.uri,
    sourceUrl: proof.sourceUrl,
    sha256: proof.sha256,
    observedAt: proof.observedAt,
  };
}
const hasControls = (value: string) =>
  Array.from(value).some((c) => {
    const code = c.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });

// Fixed public storage gateways only. Neither redirects nor arbitrary metadata hosts are fetched.
export function metadataGateway(uri: string): string {
  if (!uri || uri.length > 2048 || hasControls(uri) || uri.includes('\\'))
    throw new Error('Unsupported metadata URI.');
  const candidate = uri.startsWith('ipfs://')
    ? `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, '')}`
    : uri.startsWith('ar://')
      ? `https://arweave.net/${uri.slice(5)}`
      : uri;
  const url = new URL(candidate);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error('Unsupported metadata URI.');
  const path = url.pathname;
  const ipfs =
    ['ipfs.io', 'gateway.pinata.cloud', 'nftstorage.link'].includes(
      url.hostname,
    ) &&
    /^\/ipfs\/(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})(?:\/[^%?#]*)?$/.test(
      path,
    );
  const permanent =
    ['arweave.net', 'gateway.irys.xyz'].includes(url.hostname) &&
    /^\/[A-Za-z0-9_-]{43}(?:\/[^%?#]*)?$/.test(path);
  const github =
    url.hostname === 'raw.githubusercontent.com' &&
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[^%?#]+$/.test(path);
  if (!ipfs && !permanent && !github)
    throw new Error('Unsupported metadata host or path.');
  // Preserve the exact CID and path through one fixed HTTP gateway.
  // Sponsored ipfs.io reads can now return a service-worker-only response.
  if (ipfs) url.hostname = 'gateway.pinata.cloud';
  return url.href;
}

export function publicMetadataLink(
  value: unknown,
  kind?: 'twitter' | 'telegram',
) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 2048 ||
    hasControls(value) ||
    value.includes('\\')
  )
    throw new Error('Invalid metadata link.');
  const normalized =
    value.trim().startsWith('ipfs://') || value.trim().startsWith('ar://')
      ? metadataGateway(value.trim())
      : value.trim();
  let url = new URL(normalized);
  if (
    ['ipfs.io', 'gateway.pinata.cloud', 'nftstorage.link'].includes(
      url.hostname,
    )
  )
    url = new URL(metadataGateway(normalized));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.endsWith('.local') ||
    url.hostname.endsWith('.internal') ||
    url.hostname.endsWith('.') ||
    url.hostname.includes(':') ||
    /^[\d.]+$/.test(url.hostname)
  )
    throw new Error('Invalid metadata link.');
  if (
    kind === 'twitter' &&
    !['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(
      url.hostname,
    )
  )
    throw new Error('Unexpected X link host.');
  if (
    kind === 'telegram' &&
    !['t.me', 'telegram.me', 'www.t.me'].includes(url.hostname)
  )
    throw new Error('Unexpected Telegram link host.');
  return url.href;
}

export function decodeLinkedMetadata(
  value: unknown,
  token: Pick<ImportedToken, 'name' | 'symbol'>,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid metadata document.');
  const doc = value as Record<string, unknown>;
  // On-chain identity stays authoritative; off-chain names cannot silently replace it.
  for (const key of ['name', 'symbol'] as const) {
    if (
      doc[key] !== undefined &&
      (typeof doc[key] !== 'string' || doc[key].trim() !== token[key].trim())
    )
      throw new Error('Linked metadata identity mismatch.');
  }
  const fields: CloneMetadataFields = {},
    warnings: string[] = [];
  if (doc.description !== undefined) {
    const description =
      typeof doc.description === 'string' ? doc.description.trim() : null;
    if (
      description &&
      description.length <= 280 &&
      !hasControls(description.replace(/[\n\r\t]/g, ''))
    )
      fields.description = description;
    else
      warnings.push(
        'Description omitted: missing text, unsupported controls or more than 280 characters.',
      );
  }
  const extensions =
    doc.extensions &&
    typeof doc.extensions === 'object' &&
    !Array.isArray(doc.extensions)
      ? (doc.extensions as Record<string, unknown>)
      : {};
  const sources = {
    artworkUrl: doc.image,
    website: doc.website ?? extensions.website ?? doc.external_url,
    twitter: doc.twitter ?? extensions.twitter,
    telegram: doc.telegram ?? extensions.telegram,
  };
  for (const key of ['artworkUrl', 'website', 'twitter', 'telegram'] as const) {
    if (sources[key] === undefined || sources[key] === '') continue;
    try {
      fields[key] = publicMetadataLink(
        sources[key],
        key === 'twitter' || key === 'telegram' ? key : undefined,
      );
    } catch {
      warnings.push(`${key} omitted: unsupported public HTTPS link.`);
    }
  }
  return { fields, warnings };
}

export async function readLinkedTokenMetadata(
  token: ImportedToken,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<LinkedTokenMetadata> {
  const sourceUrl = metadataGateway(token.metadataUri);
  const response = await fetcher(sourceUrl, {
    signal,
    redirect: 'manual',
    cache: 'no-store',
    credentials: 'omit',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Metadata storage unavailable.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty metadata response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 131072) {
        await reader.cancel();
        throw new Error('Metadata document too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const result = decodeLinkedMetadata(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    token,
  );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    ...result,
    uri: token.metadataUri,
    sourceUrl,
    sha256: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(''),
    observedAt: new Date().toISOString(),
  };
}
