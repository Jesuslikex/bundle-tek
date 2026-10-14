'use client';

import { useState, type FocusEvent, type MouseEvent } from 'react';
import { ArrowRight, ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DEFAULT_LAUNCH_PLAN, type LaunchPlanInput } from '@/lib/launch-plan';
import { EMPTY_IDENTITY, type TokenIdentity } from '@/lib/workspace-project';
import { TokenCloneLookup } from './token-clone-lookup';
import { ArtworkUpload } from './artwork-upload';
import { ArtworkLibrary } from './artwork-library';
import { isUploadedArtwork } from '@/lib/artwork';
import { venueLimits, validateVenuePlan } from '@/lib/venue-limits';
import {
  LaunchMetadataReview,
  type MetadataProject,
} from './launch-metadata-review';

/**
 * New drafts start with default name and ticker values. Select them on focus so
 * typing replaces the default instead of appending to it ("Untitled PlanMy Token").
 */
function replaceDefaultOnFocus(isDefault: boolean) {
  if (!isDefault) return {};
  return {
    onFocus: (e: FocusEvent<HTMLInputElement>) => e.currentTarget.select(),
    // A click would otherwise place the caret and drop the selection.
    onMouseUp: (e: MouseEvent<HTMLInputElement>) => e.preventDefault(),
  };
}

export function TokenDetailsForm({
  plan,
  onChange,
  onNext,
  identity = EMPTY_IDENTITY,
  onIdentityChange,
  validationError,
  metadataProject,
  onSave,
  saving,
}: {
  plan: LaunchPlanInput;
  onChange: (change: Partial<LaunchPlanInput>) => void;
  onNext: () => void;
  identity?: TokenIdentity;
  onIdentityChange?: (change: Partial<TokenIdentity>) => void;
  validationError?: string | null;
  metadataProject?: MetadataProject | null;
  onSave?: () => void;
  saving?: boolean;
}) {
  const [failedImage, setFailedImage] = useState('');
  const limits = venueLimits(plan.chain, plan.launchpad);
  let venueError = '';
  try {
    validateVenuePlan(plan, true);
  } catch (error) {
    venueError =
      error instanceof Error ? error.message : 'Check venue requirements.';
  }
  const ready =
    plan.tokenName.trim().length > 1 &&
    /^[A-Z0-9]{1,16}$/.test(plan.ticker) &&
    !venueError &&
    !(plan.tokenName === 'Untitled Plan' && plan.ticker === 'TOKEN');
  const artwork =
    (/^https?:\/\//.test(identity.artworkUrl) ||
      isUploadedArtwork(identity.artworkUrl)) &&
    identity.artworkUrl !== failedImage;
  return (
    <div className="settings-scroll launch-flow-scroll">
      <div className="page-title">
        <span className="eyebrow">CREATE LAUNCH / 02</span>
        <h1>Token details</h1>
        <p>Define your token’s identity and preview how it will appear.</p>
      </div>
      <div className="form-body token-form">
        <TokenCloneLookup
          onApply={(token) => {
            onChange({
              tokenName: token.name,
              ticker: token.symbol.toUpperCase(),
            });
            onIdentityChange?.({
              clonedFrom: { chain: token.chain, address: token.address },
              clonedMetadata:
                identity.clonedFrom?.chain === token.chain &&
                identity.clonedFrom.address === token.address
                  ? identity.clonedMetadata
                  : undefined,
            });
          }}
          onApplyMetadata={(token, fields, metadata) => {
            const { description, ...links } = fields;
            if (description !== undefined) onChange({ description });
            onIdentityChange?.({
              ...links,
              clonedFrom: { chain: token.chain, address: token.address },
              clonedMetadata: {
                uri: metadata.uri,
                sourceUrl: metadata.sourceUrl,
                sha256: metadata.sha256,
                observedAt: metadata.observedAt,
              },
            });
          }}
        />
        {identity.clonedFrom && (
          <div className="token-clone-source">
            <span>Cloned from {identity.clonedFrom.chain}</span>
            <code>{identity.clonedFrom.address}</code>
            {identity.clonedMetadata && (
              <details>
                <summary>Linked metadata source</summary>
                <p>
                  Read{' '}
                  {new Date(
                    identity.clonedMetadata.observedAt,
                  ).toLocaleString()}{' '}
                  from{' '}
                  <a
                    href={identity.clonedMetadata.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {new URL(identity.clonedMetadata.sourceUrl).hostname}
                  </a>
                  . Hosted content can change after this read.
                </p>
                <code
                  style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}
                >
                  {identity.clonedMetadata.sha256}
                </code>
              </details>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                onIdentityChange?.({
                  clonedFrom: undefined,
                  clonedMetadata: undefined,
                })
              }
            >
              Remove source reference
            </Button>
          </div>
        )}
        {validationError && (
          <p role="alert" className="draft-error">
            {validationError}
          </p>
        )}
        <div className="input-grid">
          <div>
            <label htmlFor="project-name">
              Project name{' '}
              <small>
                {plan.tokenName.length}/{limits.maxName}
              </small>
            </label>
            <Input
              id="project-name"
              maxLength={limits.maxName}
              value={plan.tokenName}
              onChange={(e) => onChange({ tokenName: e.target.value })}
              {...replaceDefaultOnFocus(
                plan.tokenName === DEFAULT_LAUNCH_PLAN.tokenName,
              )}
              placeholder="Project name"
            />
          </div>
          <div>
            <label htmlFor="project-symbol">
              Symbol{' '}
              <small>
                {plan.ticker.length}/{limits.maxSymbol}
              </small>
            </label>
            <Input
              id="project-symbol"
              maxLength={limits.maxSymbol}
              value={plan.ticker}
              onChange={(e) =>
                onChange({
                  ticker: e.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, ''),
                })
              }
              {...replaceDefaultOnFocus(
                plan.ticker === DEFAULT_LAUNCH_PLAN.ticker,
              )}
              placeholder="TOKEN"
            />
          </div>
        </div>
        {limits.maxCombined < 99999 ? (
          <p className="venue-identity-limits">
            Name and symbol combined:{' '}
            {plan.tokenName.trim().length + plan.ticker.trim().length}/
            {limits.maxCombined} characters.
          </p>
        ) : null}
        {!limits.verified ? (
          <p className="source-note">
            Venue-specific limits for this profile are not yet verified. General
            draft limits apply.
          </p>
        ) : null}
        {venueError && venueError !== validationError ? (
          <p role="alert" className="draft-error">
            {venueError}
          </p>
        ) : null}
        <div>
          <label htmlFor="project-description">
            Description{' '}
            {limits.descriptionOptional
              ? '(optional)'
              : '(required before continuing)'}{' '}
            <small>{plan.description.length}/280</small>
          </label>
          <textarea
            id="project-description"
            maxLength={280}
            value={plan.description}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="What is your project about?"
          />
        </div>
        <div>
          <label htmlFor="artwork-url">
            Artwork URL <small>Optional</small>
          </label>
          <Input
            id="artwork-url"
            type="url"
            value={
              isUploadedArtwork(identity.artworkUrl) ? '' : identity.artworkUrl
            }
            onChange={(e) => onIdentityChange?.({ artworkUrl: e.target.value })}
            placeholder="https://…/token.png"
          />
          <p className="source-note">
            {isUploadedArtwork(identity.artworkUrl)
              ? 'Uploaded image selected. Enter a hosted URL to replace it.'
              : 'Use a hosted image URL or upload an image below.'}
          </p>
        </div>
        <ArtworkUpload
          onUploaded={(url) => {
            setFailedImage('');
            onIdentityChange?.({ artworkUrl: url });
          }}
        />
        <ArtworkLibrary
          selectedUrl={identity.artworkUrl}
          onSelected={(url) => {
            setFailedImage('');
            onIdentityChange?.({ artworkUrl: url });
          }}
        />
        {identity.artworkUrl && (
          <Button
            type="button"
            variant="outline"
            onClick={() => onIdentityChange?.({ artworkUrl: '' })}
          >
            Remove artwork from draft
          </Button>
        )}
        <section className="identity-preview" aria-label="Token preview">
          <div className="identity-art">
            {artwork ? (
              // oxlint-disable-next-line next/no-img-element -- Preview user URLs client-side without introducing a server-side image proxy.
              <img
                src={identity.artworkUrl}
                alt="Token artwork preview"
                referrerPolicy="no-referrer"
                onError={() => setFailedImage(identity.artworkUrl)}
              />
            ) : (
              <ImagePlus />
            )}
          </div>
          <div>
            <span>PREVIEW</span>
            <h2>
              {plan.tokenName || 'Project name'}{' '}
              <small>${plan.ticker || 'TOKEN'}</small>
            </h2>
            <p>
              {plan.description || 'Your project description will appear here.'}
            </p>
            <small>
              {plan.launchpad} · {plan.chain}
            </small>
          </div>
        </section>
        {identity.artworkUrl && failedImage === identity.artworkUrl && (
          <output className="inspection-error">
            Image could not load. Check the URL or upload the image again.
          </output>
        )}
        <div className="social-fields">
          {(
            [
              ['twitter', 'X / Twitter'],
              ['telegram', 'Telegram'],
              ['website', 'Website'],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <label htmlFor={`identity-${key}`}>
                {label} <small>Optional</small>
              </label>
              <Input
                id={`identity-${key}`}
                type="url"
                value={identity[key]}
                onChange={(e) => onIdentityChange?.({ [key]: e.target.value })}
                placeholder="https://…"
              />
            </div>
          ))}
        </div>
        <LaunchMetadataReview
          plan={plan}
          identity={identity}
          project={metadataProject}
          onSave={onSave}
          saving={saving}
        />
        <Button className="flow-next" disabled={!ready} onClick={onNext}>
          Continue to launch settings <ArrowRight />
        </Button>
        {!ready && (
          <p className="next-action-note">
            {venueError || 'Enter your project name and symbol to continue.'}
          </p>
        )}
      </div>
    </div>
  );
}
