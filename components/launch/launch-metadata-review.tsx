'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { isUploadedArtwork } from '@/lib/artwork';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import type { TokenIdentity } from '@/lib/workspace-project';
import { readPanelJson } from '@/components/read-panel-json';
import { PumpLaunchReview } from './pump-launch-review';

export type MetadataProject = {
  id: string;
  updatedAt: string;
  payer?: { address: string; revision: number };
};
type Props = {
  plan: LaunchPlanInput;
  identity: TokenIdentity;
  project?: MetadataProject | null;
  onSave?: () => void;
  saving?: boolean;
  onCreateOnly?: () => void;
};
const interrupted =
  'Publication may have completed. Retry this same saved draft to recover its link.';
class MetadataReviewError extends Error {}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function SavedMetadataReview({
  plan,
  identity,
  project,
  onSave,
  saving,
  onCreateOnly,
}: Props) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uri, setUri] = useState('');
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      const controller = pending.current;
      pending.current = null;
      controller?.abort();
    },
    [],
  );
  const artworkReady = isUploadedArtwork(identity.artworkUrl);
  async function publish() {
    if (
      !project ||
      !consent ||
      busy ||
      pending.current ||
      !artworkReady ||
      saving
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const [response, body] = await Promise.race([
        (async () => {
          const response = await fetch('/api/launch/metadata', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              projectId: project.id,
              updatedAt: project.updatedAt,
              publishPublicly: true,
            }),
          });
          return [
            response,
            await readPanelJson(response, interrupted),
          ] as const;
        })(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(interrupted));
          }, 25000);
        }),
      ]);
      if (pending.current !== controller) return;
      if (!response.ok) {
        throw new MetadataReviewError(
          response.status === 401
            ? 'Sign in before publishing metadata.'
            : response.status === 409
              ? 'The project or artwork changed, or its release limit was reached. Reload and review it again.'
              : response.status === 400
                ? 'Save an active Solana launch with uploaded artwork on an HTTPS site.'
                : interrupted,
        );
      }
      const id = isRecord(body) && typeof body.id === 'string' ? body.id : '';
      const expected = `${window.location.origin}/api/launch/metadata/${id}`;
      if (
        !isRecord(body) ||
        !/^[a-f0-9]{64}$/.test(id) ||
        body.uri !== expected ||
        body.executionAllowed !== false ||
        !isRecord(body.metadata) ||
        body.metadata.name !== plan.tokenName ||
        body.metadata.symbol !== plan.ticker ||
        body.metadata.description !== plan.description ||
        body.metadata.image !== `${expected}/image` ||
        ['website', 'twitter', 'telegram'].some(
          (key) =>
            body.metadata &&
            (body.metadata as Record<string, unknown>)[key] !==
              (identity[key as 'website'] || undefined),
        )
      )
        throw new Error(interrupted);
      setUri(expected);
    } catch (cause) {
      if (pending.current === controller)
        setError(
          cause instanceof MetadataReviewError ? cause.message : interrupted,
        );
    } finally {
      if (timeout) clearTimeout(timeout);
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <details
      className="metadata-review"
      style={{
        borderTop: '1px solid var(--border)',
        paddingTop: 16,
        marginTop: 20,
      }}
    >
      <summary style={{ cursor: 'pointer' }}>
        Review public token metadata
      </summary>
      <div style={{ display: 'grid', gap: 12, paddingTop: 16, minWidth: 0 }}>
        <p className="source-note">
          Prepare the image and details wallets will display. Publishing
          metadata does not create a coin or trading pair.
        </p>
        {!project ? (
          <>
            <p>
              Save your active project and finish pending edits before reviewing
              publication.
            </p>
            {onSave && (
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={onSave}
              >
                {saving
                  ? 'Saving project…'
                  : 'Save project for metadata review'}
              </Button>
            )}
          </>
        ) : (
          <>
            <dl style={{ margin: 0, overflowWrap: 'anywhere' }}>
              <dt>Name</dt>
              <dd>{plan.tokenName}</dd>
              <dt>Symbol</dt>
              <dd>{plan.ticker}</dd>
              <dt>Description</dt>
              <dd>{plan.description || 'No description'}</dd>
              {(['website', 'twitter', 'telegram'] as const)
                .filter((key) => identity[key])
                .map((key) => (
                  <div key={key}>
                    <dt>
                      {key === 'twitter'
                        ? 'X / Twitter'
                        : key === 'website'
                          ? 'Website'
                          : 'Telegram'}
                    </dt>
                    <dd>{identity[key]}</dd>
                  </div>
                ))}
            </dl>
            {artworkReady ? (
              // oxlint-disable-next-line next/no-img-element -- Preview the exact private upload without a public image proxy.
              <img
                src={identity.artworkUrl}
                alt="Artwork to publish"
                width={80}
                height={80}
                referrerPolicy="no-referrer"
                style={{ objectFit: 'contain' }}
              />
            ) : (
              <p>
                Upload an image, select it and save the project before
                publishing. A hosted image URL alone cannot be released here.
              </p>
            )}
            <p className="source-note">
              The details above and selected image will be public. Published
              copies cannot be changed or removed through this app. Deleting the
              private image or editing the draft will not revoke them. Links
              depend on continued hosting of this site.
            </p>
            {!uri && (
              <>
                <label
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}
                >
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={busy || !artworkReady || saving}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  <span>
                    I approve publishing these token details and this image
                    publicly.
                  </span>
                </label>
                <Button
                  type="button"
                  disabled={!consent || !artworkReady || busy || saving}
                  onClick={() => void publish()}
                >
                  {busy ? 'Publishing metadata…' : 'Publish reviewed metadata'}
                </Button>
              </>
            )}
          </>
        )}
        <div aria-live="polite" style={{ overflowWrap: 'anywhere' }}>
          {busy && (
            <p>
              Keep this review open. If interrupted, publication may still
              complete.
            </p>
          )}
          {error && (
            <p role="alert" className="inspection-error">
              {error}
            </p>
          )}
          {uri && (
            <p>
              Metadata published.{' '}
              <a href={uri} target="_blank" rel="noreferrer">
                Open public metadata
              </a>
              <br />
              <code>{uri}</code>
              <br />
              Coin creation still requires a separate transaction review.
            </p>
          )}
        </div>
      </div>
      {project && plan.launchpad === 'PumpFun' && (
        <PumpLaunchReview
          project={project}
          plan={plan}
          releaseId={uri.split('/').at(-1) ?? ''}
          onCreateOnly={onCreateOnly}
        />
      )}
    </details>
  );
}

export function LaunchMetadataReview(props: Props) {
  if (
    props.plan.chain !== 'Solana' ||
    !['PumpFun', 'StonkFun'].includes(props.plan.launchpad)
  )
    return null;
  // Consent, outstanding responses and links belong only to this exact draft.
  const context = JSON.stringify([
    props.project,
    props.saving,
    props.plan,
    props.identity,
  ]);
  return <SavedMetadataReview key={context} {...props} />;
}
