'use client';
import { useEffect, useRef, useState } from 'react';
import {
  MarketplaceInventoryClockError,
  type MarketplaceOwnedInventory,
} from '@/lib/marketplace-owned-inventory';
import type { OperatorListingReview } from '@/lib/marketplace-operator-review';
import {
  admitMarketplaceTokenInspection,
  MarketplaceTokenInspectionClockError,
  MARKETPLACE_TOKEN_PROGRAMS,
  type MarketplaceTokenInspection,
} from '@/lib/marketplace-token-inspection-view';
import { readPanelJson } from './read-panel-json';
import styles from './marketplace-owned-wallets.module.css';
import tokenStyles from './marketplace-token-inspection-panel.module.css';
const PAGE_SIZE = 20;
export function MarketplaceTokenInspectionPanel({
  inventory,
  selection,
}: {
  inventory: MarketplaceOwnedInventory;
  selection: OperatorListingReview['selection'];
}) {
  const [result, setResult] = useState<MarketplaceTokenInspection | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [cooldown, setCooldown] = useState(false),
    [cooldownKey, setCooldownKey] = useState(0),
    [page, setPage] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const pageHeading = useRef<HTMLHeadingElement | null>(null);
  const requestedPageFocus = useRef(false);
  useEffect(() => {
    if (!requestedPageFocus.current) return;
    requestedPageFocus.current = false;
    pageHeading.current?.focus();
  }, [page]);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (cooldownKey === 0) return;
    const timer = setTimeout(() => setCooldown(false), 15000);
    return () => clearTimeout(timer);
  }, [cooldownKey]);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(
      () => {
        setResult(null);
        setPage(0);
        setMessage(
          'Owned token inspection expired. Inspect manually for a new snapshot.',
        );
      },
      Math.max(0, Date.parse(result.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [result]);
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setResult(null);
    setPage(0);
    requestedPageFocus.current = false;
    setMessage(
      'Owned token inspection cancelled. Wait 15 seconds from the request before trying again. Nothing was published or paid.',
    );
  }
  async function inspect() {
    if (pending.current || cooldown) return;
    const controller = new AbortController();
    pending.current = controller;
    const live = () =>
      pending.current === controller && !controller.signal.aborted;
    setBusy(true);
    setCooldown(true);
    setCooldownKey((k) => k + 1);
    setResult(null);
    setPage(0);
    requestedPageFocus.current = false;
    setMessage('');
    try {
      const response = await fetch(
        '/api/marketplace/operator/token-inspection',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(selection),
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(60000),
          ]),
        },
      );
      const data = await readPanelJson(
        response,
        'Owned token inspection unavailable.',
      );
      if (!live()) return;
      if (!response.ok) {
        if (response.status === 429) {
          setCooldown(true);
          setCooldownKey((k) => k + 1);
        }
        setMessage(
          response.status === 401
            ? 'Sign in before inspecting owned tokens.'
            : response.status === 403
              ? 'Seller access changed. Sign in again.'
              : response.status === 409
                ? 'Seller evidence changed. Reload inventory and review again; wait 15 seconds from the last inspection.'
                : response.status === 429
                  ? 'Rate limited. Wait at least 15 seconds, then inspect manually.'
                  : response.status === 400
                    ? 'The selected wallet or asking price was rejected. Reload inventory and review the selection again.'
                    : response.status === 408
                      ? 'Owned token inspection stopped. Wait 15 seconds from the request before trying again.'
                      : response.status === 413
                        ? 'The request was too large. Reload inventory and choose one wallet.'
                        : response.status === 415
                          ? 'The request format was rejected. Reload the page before trying again.'
                          : 'Owned token inspection unavailable or exceeds supported coverage. No empty-wallet, sale or payment approval was issued.',
        );
        return;
      }
      const admitted = await admitMarketplaceTokenInspection(
        data,
        inventory,
        selection,
      );
      if (!live()) return;
      if (Date.now() >= Date.parse(admitted.expiresAt))
        throw new MarketplaceTokenInspectionClockError();
      setResult(admitted);
    } catch (error) {
      if (live())
        setMessage(
          error instanceof MarketplaceTokenInspectionClockError ||
            error instanceof MarketplaceInventoryClockError
            ? error.message
            : 'Owned token inspection could not be verified. Reload inventory and inspect manually after the cooldown.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const rows =
    result?.accounts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? [];
  const lastPage = Math.max(
    0,
    Math.ceil((result?.accountCount ?? 0) / PAGE_SIZE) - 1,
  );
  function movePage(direction: -1 | 1) {
    requestedPageFocus.current = true;
    setPage((current) => Math.min(lastPage, Math.max(0, current + direction)));
  }
  return (
    <section
      className={styles.notice}
      aria-label="Owned token account inspection"
      aria-busy={busy}
    >
      <h2>Owned token accounts</h2>
      <p>
        Check this wallet’s accounts under both token programs. This is separate
        from the SOL account check and does not approve a sale or token
        transfer.
      </p>
      <code>{selection.address}</code>
      <div className={styles.controls}>
        <button disabled={busy || cooldown} onClick={() => void inspect()}>
          {busy
            ? 'Inspecting owned tokens…'
            : result
              ? 'Inspect owned tokens again'
              : 'Inspect owned token accounts'}
        </button>
        {busy && <button onClick={cancel}>Cancel token inspection</button>}
      </div>
      {cooldown && (
        <p>
          New token inspections are available after the 15-second cooldown.
          There is no automatic retry.
        </p>
      )}
      {message && <output>{message}</output>}
      {result && (
        <div aria-label="Owned token inspection result">
          <div aria-live="polite">
            <strong>
              {result.accountCount} owned token accounts returned by the
              provider
            </strong>
            <p>
              Original Token Program and Token-2022 were both read. An empty
              response is not proof of an empty wallet.
            </p>
          </div>
          <dl className={tokenStyles.summary}>
            {[
              ['With nonzero raw units', result.nonzeroRawAccounts],
              ['Frozen accounts', result.frozenAccounts],
              ['Delegates present', result.delegatedAccounts],
              ['External close authorities', result.foreignCloseAuthorities],
              ['Accounts with extensions', result.extendedAccounts],
            ].map(([label, count]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
          <p>
            {result.source} · {result.commitment} · Observed{' '}
            {new Date(result.observedAt).toLocaleString()}. Expires{' '}
            {new Date(result.expiresAt).toLocaleTimeString()}.
          </p>
          {result.accountCount > 0 && (
            <>
              <h3 aria-live="polite" tabIndex={-1} ref={pageHeading}>
                Accounts {page * PAGE_SIZE + 1}–
                {Math.min((page + 1) * PAGE_SIZE, result.accountCount)} of{' '}
                {result.accountCount}
              </h3>
              <p>
                Amounts below are raw base units; token decimals and prices have
                not been read.
              </p>
              <ul className={tokenStyles.rows}>
                {rows.map((a) => (
                  <li key={a.address}>
                    <details className={tokenStyles.account}>
                      <summary>
                        Token account {a.address.slice(0, 4)}…
                        {a.address.slice(-4)} ·{' '}
                        {a.program === MARKETPLACE_TOKEN_PROGRAMS[0]
                          ? 'Original Token'
                          : 'Token-2022'}{' '}
                        · {a.state === 'frozen' ? 'Frozen' : 'Initialized'}
                      </summary>
                      <div className={tokenStyles.tags}>
                        {a.delegate !== null && <span>Delegate present</span>}
                        {a.closeAuthority !== null &&
                          a.closeAuthority !== selection.address && (
                            <span>External close authority</span>
                          )}
                        {a.extensions.length > 0 && (
                          <span>Extension semantics need review</span>
                        )}
                      </div>
                      <dl>
                        <div>
                          <dt>Account</dt>
                          <dd>
                            <code>{a.address}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Mint</dt>
                          <dd>
                            <code>{a.mint}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Raw base units</dt>
                          <dd>{a.amountRaw}</dd>
                        </div>
                        <div>
                          <dt>Account SOL lamports</dt>
                          <dd>{a.lamports}</dd>
                        </div>
                        <div>
                          <dt>Delegate / raw allowance</dt>
                          <dd>
                            <code>{a.delegate ?? 'None recorded'}</code>
                            {a.delegatedAmountRaw}
                          </dd>
                        </div>
                        <div>
                          <dt>Close authority</dt>
                          <dd>
                            <code>
                              {a.closeAuthority ?? 'Owner by default'}
                            </code>
                          </dd>
                        </div>
                        <div>
                          <dt>Native reserve lamports</dt>
                          <dd>{a.nativeReserveRaw ?? 'Not native'}</dd>
                        </div>
                        <div>
                          <dt>Decoded account extensions</dt>
                          <dd>
                            {a.extensions.length
                              ? a.extensions.join(', ')
                              : 'None decoded'}
                          </dd>
                        </div>
                        <div>
                          <dt>Program / observation slot</dt>
                          <dd>
                            <code>{a.program}</code>
                            {a.slot}
                          </dd>
                        </div>
                      </dl>
                      <p>Encoded-data hash</p>
                      <code>{a.encodedDataSha256}</code>
                    </details>
                  </li>
                ))}
              </ul>
              <div className={styles.controls}>
                <button disabled={page === 0} onClick={() => movePage(-1)}>
                  Previous token accounts
                </button>
                <button
                  disabled={(page + 1) * PAGE_SIZE >= result.accountCount}
                  onClick={() => movePage(1)}
                >
                  Next token accounts
                </button>
              </div>
            </>
          )}
          <details>
            <summary>Coverage and remaining checks</summary>
            <p>{result.coverage}</p>
            <p>
              Program observation slots:{' '}
              {result.programs
                .map(
                  (p) =>
                    `${p.program === MARKETPLACE_TOKEN_PROGRAMS[0] ? 'Original Token' : 'Token-2022'} ${p.slot} (${p.count} accounts)`,
                )
                .join('; ')}
              . Baseline/final slots {result.floorSlot}/{result.finalSlot}.
            </p>
            <code>{result.sellerEvidenceSha256}</code>
          </details>
          <p>
            Current key control, mint-level authorities, provenance and full
            asset coverage remain unverified. Payment, key delivery and signing
            remain unavailable.
          </p>
        </div>
      )}
    </section>
  );
}
