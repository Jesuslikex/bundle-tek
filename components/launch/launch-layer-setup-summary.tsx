import type { LaunchLayerEnvelope } from '@/lib/launch-layer-terms';
import { useId, useState } from 'react';
import Image from 'next/image';
import { validateLaunchPlan, launchModeLabel } from '@/lib/launch-plan';
import styles from './launch-layer-setup-summary.module.css';
import {
  parseLaunchLayerSetup,
  type LaunchLayerSetup,
} from '@/lib/launch-layer-setup';
import { isUploadedArtwork } from '@/lib/artwork';

function SavedLayerArtwork({ url }: { url: string }) {
  const [unavailable, setUnavailable] = useState(false);
  return unavailable ? (
    <span className={styles.artwork}>
      <output>Saved artwork unavailable.</output>{' '}
      <button type="button" onClick={() => setUnavailable(false)}>
        Retry artwork
      </button>
    </span>
  ) : (
    <Image
      src={url}
      alt="Saved token artwork"
      width={40}
      height={40}
      loading="lazy"
      referrerPolicy="no-referrer"
      unoptimized
      onError={() => setUnavailable(true)}
    />
  );
}

function seconds(milliseconds: number) {
  const whole = Math.floor(milliseconds / 1000);
  const fraction = String(milliseconds % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${whole}${fraction ? '.' + fraction : ''}s`;
}

function savedPlan(envelope: LaunchLayerEnvelope) {
  try {
    const plan = validateLaunchPlan(
      JSON.parse(envelope.terms.binding.savedPlanJson),
    );
    if (
      plan.chain !== 'Solana' ||
      plan.mode !== 'Block-0' ||
      plan.launchpad !== envelope.terms.launchpad ||
      plan.currency !== envelope.terms.quote.symbol ||
      (plan.quoteAddress &&
        plan.quoteAddress !== envelope.terms.quote.address) ||
      plan.holderCount !== envelope.terms.roles.holders.length
    )
      return null;
    return plan;
  } catch {
    return null;
  }
}
/** Structural/URL checks here; the owner-scoped service/client bind project/root upstream. */
function displaySetup(
  setup: LaunchLayerSetup | undefined,
  envelope: LaunchLayerEnvelope,
) {
  if (!setup) return undefined;
  try {
    return parseLaunchLayerSetup(setup, envelope, {
      projectId: setup.projectId,
      projectUpdatedAt: envelope.terms.binding.savedPlanUpdatedAt,
      snapshotSha256: setup.snapshotSha256,
    });
  } catch {
    return undefined;
  }
}

/** Restates bound terms and projected source choices, never live execution readiness. */
export function LaunchLayerSetupSummary({
  envelope,
  contextLabel = 'Layer',
  setup,
}: {
  envelope: LaunchLayerEnvelope;
  contextLabel?: string;
  setup?: LaunchLayerSetup;
}) {
  const headingId = useId();
  const { roles, delays, quote, launchpad, binding } = envelope.terms;
  const plan = savedPlan(envelope);
  const source = displaySetup(setup, envelope);
  const pump = source?.pumpfun;
  const noPump = source ? 'Not applicable (StonkFun)' : 'Unavailable';
  const links = source
    ? (['website', 'twitter', 'telegram'] as const).filter(
        (key) => source.identity[key],
      )
    : [];
  const externalArtwork =
    source?.identity.artworkUrl &&
    !isUploadedArtwork(source.identity.artworkUrl)
      ? source.identity.artworkUrl
      : null;
  const hasDetails = Boolean(
    source && (externalArtwork || links.length || pump),
  );
  const tiles = [
    ['Launchpad', launchpad],
    ['Quote', quote.symbol],
    ['Mode', plan ? launchModeLabel(plan.mode) : 'Unavailable'],
    ['Preset', plan ? `${plan.preset} Build` : 'Unavailable'],
    ['Target', binding.target.kind === 'new' ? 'New token' : 'Existing token'],
    ['Funder', '1 wallet'],
    ['Developer', roles.developer ? '1 wallet' : 'No developer wallet'],
    ['Front buyers', String(roles.front.length)],
    ['Back buyers', String(roles.back.length)],
    ['Temporary holders', String(roles.temporary.length)],
    ['Final holders', String(roles.holders.length)],
    [
      'Holder rewards',
      pump ? (pump.holderRewards ? 'Requested' : 'Not requested') : noPump,
    ],
    [
      'Creator fee',
      pump
        ? pump.creatorFeePercent === null
          ? 'No custom fee'
          : `${pump.creatorFeePercent}% requested`
        : noPump,
    ],
    [
      'Fee sharing',
      pump
        ? pump.feeSharing
          ? `${pump.feeShares.length} recipient(s)`
          : 'Not requested'
        : noPump,
    ],
    ['Funding delay', `${delays.fundingDelaySeconds}s`],
    [
      'Front to Back delay',
      roles.back.length ? seconds(delays.frontToBackDelayMs) : 'Not used',
    ],
    [
      'Back to temporary delay',
      roles.back.length && roles.temporary.length
        ? seconds(delays.backToTemporaryDelayMs)
        : 'Not used',
    ],
    [
      'Buy delay',
      plan
        ? plan.timing
          ? seconds(plan.timing.buyDelayMs)
          : '0s (none saved)'
        : 'Unavailable',
    ],
    [
      'Initial buy delay',
      plan
        ? plan.timing
          ? seconds(plan.timing.initialBuyDelayMs)
          : '0s (none saved)'
        : 'Unavailable',
    ],
  ];
  return (
    <section className={styles.summary} aria-labelledby={headingId}>
      <h5 id={headingId}>{contextLabel} configuration</h5>
      <div className={styles.token}>
        {source && isUploadedArtwork(source.identity.artworkUrl) && (
          <SavedLayerArtwork
            key={source.identity.artworkUrl}
            url={source.identity.artworkUrl}
          />
        )}
        {plan ? (
          <p>
            Saved name: <strong>${plan.ticker}</strong> {plan.tokenName}
          </p>
        ) : (
          <output>
            Saved launch details are unavailable. Preset and buy timings cannot
            be confirmed.
          </output>
        )}
      </div>
      <dl className={styles.tiles}>
        {tiles.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        {source
          ? `${source.snapshotSha256 === null ? 'Artwork and venue choices come from the loaded saved project.' : 'Artwork and venue choices come from the retained project snapshot.'} They are saved requests, not verified execution settings. Slippage and actual funding readiness are not confirmed here.`
          : 'Artwork and venue choices are unavailable for this review. Slippage, rewards and fee sharing are not confirmed here.'}
      </p>
      {source && hasDetails && (
        <details className={styles.identity}>
          <summary>
            {pump
              ? 'Saved project artwork, links and fee shares'
              : 'Saved project artwork and links'}
          </summary>
          {externalArtwork && (
            <p>
              <a
                href={externalArtwork}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open saved external artwork
              </a>
            </p>
          )}
          {links.length > 0 && (
            <ul>
              {links.map((key) => (
                <li key={key}>
                  <a
                    href={source.identity[key]}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {key === 'twitter'
                      ? 'X'
                      : key === 'telegram'
                        ? 'Telegram'
                        : 'Website'}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {pump?.feeSharing && (
            <ul aria-label="Saved fee shares">
              {pump.feeShares.map((leg) => (
                <li key={leg.address}>
                  <code>{leg.address}</code>: {leg.shareBps / 100}%
                </li>
              ))}
            </ul>
          )}
          {pump && (
            <p>
              Offchain creation:{' '}
              {pump.offchainCreation ? 'Requested' : 'Not requested'}. These
              settings do not authorize a launch.
            </p>
          )}
        </details>
      )}
      <details className={styles.identity}>
        <summary>Token and quote addresses</summary>
        <dl>
          <dt>Token mint</dt>
          <dd>
            <code>{binding.target.mint}</code>
          </dd>
          <dt>Quote mint</dt>
          <dd>
            <code>{quote.address}</code>
          </dd>
        </dl>
      </details>
    </section>
  );
}
