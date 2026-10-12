'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ImportedToken } from '@/lib/token-import';
import {
  metadataGateway,
  type CloneMetadataFields,
  type LinkedTokenMetadata,
} from '@/lib/token-linked-metadata';
const labels = {
  description: 'Description',
  artworkUrl: 'Artwork URL',
  website: 'Website',
  twitter: 'X / Twitter',
  telegram: 'Telegram',
};
export function TokenLinkedMetadataReview({
  token,
  onApply,
}: {
  token: ImportedToken;
  onApply: (fields: CloneMetadataFields, metadata: LinkedTokenMetadata) => void;
}) {
  const [metadata, setMetadata] = useState<LinkedTokenMetadata | null>(null);
  const [selected, setSelected] = useState<Array<keyof CloneMetadataFields>>(
    [],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  let supported = token.chain === 'Solana';
  try {
    metadataGateway(token.metadataUri);
  } catch {
    supported = false;
  }
  async function read() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/tokens/linked-metadata?${new URLSearchParams({ chain: token.chain, address: token.address, uri: token.metadataUri })}`,
        { signal: controller.signal, cache: 'no-store' },
      );
      const data = (await response.json()) as {
        token?: ImportedToken;
        metadata?: LinkedTokenMetadata;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Linked metadata unavailable.');
      if (
        data.token?.chain !== token.chain ||
        data.token.address !== token.address ||
        data.token.name !== token.name ||
        data.token.symbol !== token.symbol ||
        data.token.metadataUri !== token.metadataUri ||
        !data.metadata ||
        data.metadata.uri !== token.metadataUri
      )
        throw new Error('Token identity changed. Look up the token again.');
      if (!controller.signal.aborted) {
        setMetadata(data.metadata);
        setSelected([]);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Linked metadata unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Linked token metadata">
      <h4>Linked description, artwork and social links</h4>
      <p>
        Read the mint’s linked JSON separately, then choose fields to replace in
        this draft. Text and URLs are issuer-provided and do not prove
        authenticity. Artwork is copied as a hosted URL; no image is uploaded or
        published.
      </p>
      <p>
        IPFS reads and IPFS artwork links use the public Pinata gateway with the
        same content ID and path. Gateway availability is not guaranteed.
      </p>
      {token.metadataUri && (
        <p>
          On-chain metadata URI: <code>{token.metadataUri}</code>
        </p>
      )}
      {!supported && (
        <p>
          Linked reads currently support Solana metadata on IPFS, Arweave, Irys
          and public GitHub storage. Enter other metadata manually.
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={!supported || busy}
        onClick={() => void read()}
      >
        {busy ? 'Reading linked metadata…' : 'Read linked metadata'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {metadata && (
        <div>
          <p>
            Read {new Date(metadata.observedAt).toLocaleString()} from{' '}
            <a href={metadata.sourceUrl} target="_blank" rel="noreferrer">
              {new URL(metadata.sourceUrl).hostname}
            </a>
            .
          </p>
          <details>
            <summary>Metadata source digest</summary>
            <code>{metadata.sha256}</code>
            <p>
              Digest of this JSON read. It does not verify the issuer or
              guarantee that hosted content stays unchanged.
            </p>
          </details>
          {metadata.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          {(Object.keys(labels) as Array<keyof CloneMetadataFields>)
            .filter((field) => metadata.fields[field] !== undefined)
            .map((field) => (
              <div key={field}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(field)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, field]
                          : current.filter((item) => item !== field),
                      )
                    }
                  />{' '}
                  Copy {labels[field]}
                </label>
                <p
                  style={{
                    overflowWrap: 'anywhere',
                    whiteSpace:
                      field === 'description' ? 'pre-wrap' : undefined,
                  }}
                >
                  {metadata.fields[field]}
                </p>
              </div>
            ))}
          {!Object.keys(metadata.fields).length && (
            <p>
              No supported description, artwork or social fields in this
              document.
            </p>
          )}
          <Button
            type="button"
            disabled={busy || !selected.length}
            onClick={() =>
              onApply(
                Object.fromEntries(
                  selected.map((key) => [key, metadata.fields[key]]),
                ),
                metadata,
              )
            }
          >
            Use selected linked details
          </Button>
        </div>
      )}
    </section>
  );
}
