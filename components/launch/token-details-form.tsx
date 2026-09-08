'use client';

import { useState } from 'react';
import { ArrowRight, ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import { EMPTY_IDENTITY, type TokenIdentity } from '@/lib/workspace-project';

export function TokenDetailsForm({
  plan,
  onChange,
  onNext,
  identity = EMPTY_IDENTITY,
  onIdentityChange,
  validationError,
}: {
  plan: LaunchPlanInput;
  onChange: (change: Partial<LaunchPlanInput>) => void;
  onNext: () => void;
  identity?: TokenIdentity;
  onIdentityChange?: (change: Partial<TokenIdentity>) => void;
  validationError?: string | null;
}) {
  const [failedImage, setFailedImage] = useState('');
  const ready =
    plan.tokenName.trim().length > 1 &&
    /^[A-Z0-9]{1,13}$/.test(plan.ticker) &&
    !(plan.tokenName === 'Untitled Plan' && plan.ticker === 'TOKEN');
  const artwork =
    /^https?:\/\//.test(identity.artworkUrl) &&
    identity.artworkUrl !== failedImage;
  return (
    <div className="settings-scroll launch-flow-scroll">
      <div className="page-title">
        <span className="eyebrow">CREATE LAUNCH / 02</span>
        <h1>Token details</h1>
        <p>Define your token’s identity and preview how it will appear.</p>
      </div>
      <div className="form-body token-form">
        {validationError && (
          <p role="alert" className="draft-error">
            {validationError}
          </p>
        )}
        <div className="input-grid">
          <div>
            <label htmlFor="project-name">
              Project name <small>{plan.tokenName.length}/32</small>
            </label>
            <Input
              id="project-name"
              maxLength={32}
              value={plan.tokenName}
              onChange={(e) => onChange({ tokenName: e.target.value })}
              placeholder="Project name"
            />
          </div>
          <div>
            <label htmlFor="project-symbol">
              Symbol <small>{plan.ticker.length}/13</small>
            </label>
            <Input
              id="project-symbol"
              value={plan.ticker}
              onChange={(e) =>
                onChange({
                  ticker: e.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, '')
                    .slice(0, 13),
                })
              }
              placeholder="TOKEN"
            />
          </div>
        </div>
        <div>
          <label htmlFor="project-description">
            Description <small>{plan.description.length}/280</small>
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
            value={identity.artworkUrl}
            onChange={(e) => onIdentityChange?.({ artworkUrl: e.target.value })}
            placeholder="https://…/token.png"
          />
          <p className="source-note">
            Use a publicly hosted image. File upload is not connected yet.
          </p>
        </div>
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
            Image could not load. Check the public URL.
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
        <Button className="flow-next" disabled={!ready} onClick={onNext}>
          Continue to launch settings <ArrowRight />
        </Button>
        {!ready && (
          <p className="next-action-note">
            Enter your project name and symbol to continue.
          </p>
        )}
      </div>
    </div>
  );
}
