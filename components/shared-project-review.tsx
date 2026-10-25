'use client';
import { holdersBuyUnit } from '@/lib/launch-buy';
import { launchModeLabel } from '@/lib/launch-plan';
import type { SharedProjectSnapshot } from '@/lib/shared-project-review';
import styles from './shared-project-review.module.css';

const yes = (value: boolean) => (value ? 'Yes' : 'No');
export function SharedProjectReview({
  project,
}: {
  project: SharedProjectSnapshot;
}) {
  const plan = project.plan;
  const allocation =
    holdersBuyUnit(plan) === 'supply'
      ? `${plan.holdersBuy}% of supply`
      : plan.holdersBuyQuote === undefined
        ? 'Quote amount not saved'
        : `${plan.holdersBuyQuote} ${plan.currency}`;
  return (
    <details key={JSON.stringify(project)} className={styles.review}>
      <summary
        aria-label={`Inspect saved plan for ${plan.tokenName} ($${plan.ticker})`}
      >
        Inspect saved plan
      </summary>
      <p className={styles.scope}>
        Read-only saved snapshot. These are planned settings, not observed
        balances, acquired supply, launch success or readiness. The owner
        retains wallet control and signing; this view grants no wallet access.
      </p>
      <h4>
        {plan.tokenName} · ${plan.ticker}
      </h4>
      {plan.description && (
        <p className={styles.description}>{plan.description}</p>
      )}
      {!project.walletSelectionMatchesPlan && (
        <p className={styles.scope}>
          Saved wallet assignments do not match these plan settings. The owner
          must review them before execution. This historical snapshot remains
          read only.
        </p>
      )}
      <dl className={styles.grid}>
        <div>
          <dt>Network</dt>
          <dd>{plan.chain}</dd>
        </div>
        <div>
          <dt>Launch venue</dt>
          <dd>{plan.launchpad}</dd>
        </div>
        <div>
          <dt>Quote asset</dt>
          <dd>{plan.currency}</dd>
        </div>
        <div>
          <dt>Quote mint / contract</dt>
          <dd>
            <code>{plan.quoteAddress ?? 'Not saved'}</code>
          </dd>
        </div>
        <div>
          <dt>Planning mode</dt>
          <dd>{launchModeLabel(plan.mode)}</dd>
        </div>
        <div>
          <dt>Preset</dt>
          <dd>{plan.preset}</dd>
        </div>
        <div>
          <dt>Developer allocation (planned)</dt>
          <dd>{plan.developerBuy}% of supply</dd>
        </div>
        <div>
          <dt>Holders buy (planned)</dt>
          <dd>{allocation}</dd>
        </div>
        <div>
          <dt>Planned holder slots</dt>
          <dd>{plan.holderCount}</dd>
        </div>
        <div>
          <dt>Assigned recipient count</dt>
          <dd>{project.assignedRecipients}</dd>
        </div>
        <div>
          <dt>Deployer assigned</dt>
          <dd>{yes(project.deployerAssigned)}</dd>
        </div>
        <div>
          <dt>Planned supply</dt>
          <dd>{project.totalSupply} token units</dd>
        </div>
        <div>
          <dt>Scheduled setting</dt>
          <dd>{yes(plan.scheduled)}</dd>
        </div>
        <div>
          <dt>Buy delay</dt>
          <dd>{plan.timing ? `${plan.timing.buyDelayMs} ms` : 'Not saved'}</dd>
        </div>
        <div>
          <dt>Initial buy delay</dt>
          <dd>
            {plan.timing ? `${plan.timing.initialBuyDelayMs} ms` : 'Not saved'}
          </dd>
        </div>
        <div>
          <dt>Exchange funding requested</dt>
          <dd>{yes(plan.useHusher)}</dd>
        </div>
        <div>
          <dt>Artwork reference saved</dt>
          <dd>{yes(project.artworkSaved)} · not loaded in this view</dd>
        </div>
        <div>
          <dt>Generic creator-tax option (saved)</dt>
          <dd>{project.creatorTax}%</dd>
        </div>
        <div>
          <dt>Community coin setting</dt>
          <dd>{yes(project.communityCoin)}</dd>
        </div>
        <div>
          <dt>Buyback setting</dt>
          <dd>{yes(project.buyback)}</dd>
        </div>
        {plan.launchpad === 'PumpFun' && (
          <>
            <div>
              <dt>Pump creator-fee setting</dt>
              <dd>
                {project.pumpSettings.creatorFeePercent === null
                  ? 'Pump default'
                  : `${project.pumpSettings.creatorFeePercent}%`}
              </dd>
            </div>
            <div>
              <dt>Holder rewards setting</dt>
              <dd>{yes(project.pumpSettings.holderRewards)}</dd>
            </div>
            <div>
              <dt>Off-chain creation setting</dt>
              <dd>{yes(project.pumpSettings.offchainCreation)}</dd>
            </div>
            <div>
              <dt>Fee sharing setting</dt>
              <dd>
                {yes(project.pumpSettings.feeSharing)} ·{' '}
                {project.pumpSettings.feeShareLegCount} planned legs
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>Saved status</dt>
          <dd>{project.archived ? 'Archived' : 'Active saved project'}</dd>
        </div>
        <div>
          <dt>Snapshot updated</dt>
          <dd>
            <time dateTime={project.updatedAt}>
              {new Date(project.updatedAt).toLocaleString()}
            </time>
          </dd>
        </div>
      </dl>
      <section
        className={styles.assignments}
        aria-label="Shared assignment references"
      >
        <h4>Shared assignment references</h4>
        {project.walletScope === undefined ? (
          <p className={styles.scope}>
            This server did not report an assignment scope. Refresh to check
            access; no wallet permission is inferred.
          </p>
        ) : (
          <>
            <p className={styles.scope}>
              {project.walletScope.mode === 'legacy'
                ? 'Legacy share: all current saved assignment references are visible. Ask the owner to revoke and invite again to limit visibility.'
                : project.walletScope.mode === 'none'
                  ? 'No assignment references are shared.'
                  : 'Only the exact references selected by the owner are visible. New wallets, changed revisions and changed roles are not added automatically.'}{' '}
              These are saved references, not proof of current balances,
              private-key ownership or signing access.
            </p>
            {project.walletScope.unavailableCount > 0 && (
              <p className={styles.scope}>
                {project.walletScope.unavailableCount} selected references no
                longer match the saved project. Ask the owner for a new invite
                if visibility is still needed.
              </p>
            )}
            <ul>
              {project.walletScope.wallets.map((wallet) => (
                <li key={`${wallet.chain}:${wallet.address}`}>
                  {wallet.role} · {wallet.chain} · revision {wallet.revision}
                  <code>{wallet.address}</code>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <p className={styles.scope}>
        This snapshot does not grant edit, funding, signing or submission
        permissions. Addresses are displayed as text; there are no wallet
        actions or external links here.
      </p>
    </details>
  );
}
