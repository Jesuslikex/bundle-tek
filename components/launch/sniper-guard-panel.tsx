'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readPanelJson } from '@/components/read-panel-json';
import type { PumpGroupView } from '@/lib/pump-launch-group-client';
import {
  parsePumpLaunchTokenWorkspace,
  pumpLaunchWorkspaceReady,
} from '@/lib/pump-launch-token-workspace';
import { PUMP_NATIVE_QUOTE } from '@/lib/pump-launch-config';
import {
  SNIPER_GUARD_FORMAT,
  sniperGuardDisplay,
  sniperGuardThresholdRaw,
  type SniperGuardLaunch,
  type SniperGuardSettings,
} from '@/lib/sniper-guard';
import type { SniperGuardView } from '@/lib/sniper-guard-service';
import { usePumpTokenWorkspaceNavigation } from './pump-token-workspace-navigation';
import styles from './pump-launch-group-ui.module.css';

const endpoint = '/api/launch/pump/sniper-guard';
export const SNIPER_GUARD_POLL_MS = 2000;
type Scope = 'all' | 'holders' | 'dev';
type Draft = {
  threshold: string;
  response: 'nuke' | 'complete-early';
  scope: Scope;
  completeEarly: boolean;
  end: 'until-complete' | 'timed';
  seconds: string;
  whitelist: string;
};
const scopeLabels: Record<Scope, string> = {
  all: 'All wallets, including dev',
  holders: 'Holders only (keep dev)',
  dev: 'Dev only (keep holders)',
};
const short = (address: string) =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;

function draftFrom(
  settings: SniperGuardSettings | null,
  decimals: number,
): Draft {
  if (!settings)
    return {
      threshold: '',
      response: 'nuke',
      scope: 'holders',
      completeEarly: true,
      end: 'timed',
      seconds: '300',
      whitelist: '',
    };
  const r = settings.response;
  return {
    threshold: sniperGuardDisplay(settings.thresholdRaw, decimals),
    response: r.kind,
    scope: r.kind === 'nuke' ? r.scope : 'holders',
    completeEarly:
      r.kind === 'nuke' && r.scope === 'dev' ? r.completeEarly : true,
    end: settings.end.kind,
    seconds:
      settings.end.kind === 'timed' ? String(settings.end.seconds) : '300',
    whitelist: settings.whitelist.join('\n'),
  };
}
export function sniperGuardSettingsFromDraft(
  draft: Draft,
  decimals: number,
): SniperGuardSettings {
  const seconds = Number(draft.seconds);
  if (
    draft.end === 'timed' &&
    (!/^\d+$/.test(draft.seconds.trim()) || seconds < 1)
  )
    throw new Error('Enter a whole number of seconds, at least 1.');
  return {
    format: SNIPER_GUARD_FORMAT,
    thresholdRaw: sniperGuardThresholdRaw(draft.threshold, decimals),
    response:
      draft.response === 'complete-early'
        ? { kind: 'complete-early' }
        : draft.scope === 'dev'
          ? { kind: 'nuke', scope: 'dev', completeEarly: draft.completeEarly }
          : { kind: 'nuke', scope: draft.scope },
    end:
      draft.end === 'timed'
        ? { kind: 'timed', seconds }
        : { kind: 'until-complete' },
    whitelist: draft.whitelist
      .split(/[\s,]+/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function notify(title: string, body: string) {
  try {
    if (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    )
      new Notification(title, { body });
  } catch {
    /* notifications are a convenience only */
  }
}

export function SniperGuardPanel({
  reviewId,
  group,
  disabled,
}: {
  reviewId: string;
  group?: PumpGroupView;
  disabled?: boolean;
}) {
  const [guard, setGuard] = useState<SniperGuardView | null>(null),
    [launch, setLaunch] = useState<SniperGuardLaunch | null>(null),
    [draft, setDraft] = useState<Draft>(() => draftFrom(null, 9)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false);
  const openTokenWorkspace = usePumpTokenWorkspaceNavigation();
  const alive = useRef(true),
    notified = useRef(false);
  const decimals = launch?.quoteDecimals ?? 9;
  const unit = launch
    ? launch.quoteMint === PUMP_NATIVE_QUOTE
      ? 'SOL'
      : `quote (${short(launch.quoteMint)})`
    : '';

  const call = useCallback(
    async (body: Record<string, unknown>) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, reviewId }),
      });
      const value = (await readPanelJson(
        response,
        'Sniper Guard response is unavailable.',
      )) as SniperGuardView & { error?: string };
      if (!response.ok) {
        const failure = new Error(
          value?.error ?? 'Sniper Guard request failed.',
        );
        (failure as Error & { status?: number }).status = response.status;
        throw failure;
      }
      return value;
    },
    [reviewId],
  );

  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const response = await fetch(
          `${endpoint}?reviewId=${encodeURIComponent(reviewId)}`,
        );
        const value = (await readPanelJson(
          response,
          'Sniper Guard is unavailable.',
        )) as {
          guard: SniperGuardView | null;
          launch: SniperGuardLaunch;
          error?: string;
        };
        if (!alive.current) return;
        if (!response.ok)
          throw new Error(value.error ?? 'Sniper Guard is unavailable.');
        setLaunch(value.launch);
        setGuard(value.guard);
        setDraft(
          draftFrom(value.guard?.settings ?? null, value.launch.quoteDecimals),
        );
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive.current) setLoaded(true);
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [reviewId]);

  // Poll only while watching and only from this open tab.
  const watchingRevision = guard?.state === 'watching' ? guard.revision : null;
  useEffect(() => {
    if (watchingRevision === null) return;
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const next = await call({
          action: 'observe',
          revision: watchingRevision,
        });
        if (!stopped) {
          setGuard(next);
          setError('');
        }
      } catch (e) {
        if (stopped) return;
        const status = (e as { status?: number }).status;
        if (status === 429 || status === 502) {
          // Re-arm the timer with the same revision: a busy gate or provider
          // hiccup must never stop the watch.
          setGuard((current) => (current ? { ...current } : current));
          if (status === 502) setError('Last chain read failed. Retrying.');
        } else setError(e instanceof Error ? e.message : String(e));
      }
    }, SNIPER_GUARD_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [watchingRevision, guard, call]);

  useEffect(() => {
    if (guard?.state !== 'triggered' || notified.current) return;
    notified.current = true;
    notify(
      'Sniper Guard triggered',
      'External buys passed your limit. Review the Nuke sells in Bundle now.',
    );
  }, [guard?.state]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const locked = disabled || busy || !launch;
  const evaluation = guard?.observation?.evaluation;
  const actions = evaluation?.actions;

  if (!loaded) return <p>Loading Sniper Guard…</p>;
  return (
    <section className={styles.panel} aria-label="Sniper Guard">
      <h4>Sniper Guard</h4>
      <p>
        Watches buys from outside wallets on this token&apos;s bonding curve.
        Buys signed by your launch wallets, any wallet you own, or the whitelist
        don&apos;t count. When the total goes over your limit, the response
        below is prepared. Bundle never sells for you: you approve and sign
        every sell yourself, and the guard only watches while this tab stays
        open.
      </p>
      {launch && (!guard || guard.state === 'planned') && (
        <form
          className={styles.review}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const settings = sniperGuardSettingsFromDraft(draft, decimals);
              setGuard(
                await call({
                  action: 'save',
                  revision: guard ? guard.revision : null,
                  settings,
                }),
              );
            });
          }}
        >
          <label>
            Limit for outside buys ({unit})
            <Input
              inputMode="decimal"
              value={draft.threshold}
              disabled={locked}
              onChange={(e) =>
                setDraft({ ...draft, threshold: e.target.value })
              }
              placeholder="5"
            />
          </label>
          <fieldset disabled={locked}>
            <legend>Response</legend>
            <label>
              <input
                type="radio"
                name="sniper-response"
                checked={draft.response === 'nuke'}
                onChange={() => setDraft({ ...draft, response: 'nuke' })}
              />{' '}
              Nuke: sell tokens from chosen wallets
            </label>
            <label>
              <input
                type="radio"
                name="sniper-response"
                checked={draft.response === 'complete-early'}
                onChange={() =>
                  setDraft({ ...draft, response: 'complete-early' })
                }
              />{' '}
              Complete Early: stop remaining holder buys, sell nothing
            </label>
            {draft.response === 'nuke' && (
              <>
                <label>
                  Sell from{' '}
                  <select
                    value={draft.scope}
                    onChange={(e) =>
                      setDraft({ ...draft, scope: e.target.value as Scope })
                    }
                  >
                    {(Object.keys(scopeLabels) as Scope[]).map((scope) => (
                      <option key={scope} value={scope}>
                        {scopeLabels[scope]}
                      </option>
                    ))}
                  </select>
                </label>
                {draft.scope === 'dev' && (
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.completeEarly}
                      onChange={(e) =>
                        setDraft({ ...draft, completeEarly: e.target.checked })
                      }
                    />{' '}
                    Also stop remaining holder buys
                  </label>
                )}
              </>
            )}
          </fieldset>
          <fieldset disabled={locked}>
            <legend>Stop watching</legend>
            <label>
              <input
                type="radio"
                name="sniper-end"
                checked={draft.end === 'timed'}
                onChange={() => setDraft({ ...draft, end: 'timed' })}
              />{' '}
              After{' '}
              <Input
                aria-label="Seconds to watch"
                inputMode="numeric"
                value={draft.seconds}
                disabled={locked || draft.end !== 'timed'}
                onChange={(e) =>
                  setDraft({ ...draft, seconds: e.target.value })
                }
              />{' '}
              seconds
            </label>
            <label>
              <input
                type="radio"
                name="sniper-end"
                checked={draft.end === 'until-complete'}
                onChange={() => setDraft({ ...draft, end: 'until-complete' })}
              />{' '}
              Until the launch buys are complete (with today&apos;s one-bundle
              launch this ends as soon as the launch is finalized)
            </label>
          </fieldset>
          <label>
            Whitelist (one address per line, optional)
            <textarea
              rows={3}
              value={draft.whitelist}
              disabled={locked}
              onChange={(e) =>
                setDraft({ ...draft, whitelist: e.target.value })
              }
            />
          </label>
          <div className={styles.actions}>
            <Button type="submit" variant="outline" disabled={locked}>
              {guard ? 'Save changes' : 'Save Sniper Guard'}
            </Button>
            {guard && (
              <Button
                type="button"
                disabled={locked}
                onClick={() =>
                  void run(async () => {
                    try {
                      if (
                        typeof Notification !== 'undefined' &&
                        Notification.permission === 'default'
                      )
                        await Notification.requestPermission();
                    } catch {
                      /* optional */
                    }
                    setGuard(
                      await call({ action: 'arm', revision: guard.revision }),
                    );
                  })
                }
              >
                Start watching
              </Button>
            )}
          </div>
        </form>
      )}
      {guard && guard.state !== 'planned' && evaluation && (
        <div className={styles.review}>
          <output>
            {guard.state === 'watching' && 'Watching. '}
            Outside buys:{' '}
            {sniperGuardDisplay(evaluation.externalTotalRaw, decimals)} of{' '}
            {sniperGuardDisplay(evaluation.thresholdRaw, decimals)} {unit} limit
            ({evaluation.counted.length + evaluation.countedOverflow} counted,{' '}
            {evaluation.excludedCount} ignored as yours or whitelisted).
          </output>
          {guard.observation?.coverage === 'partial' && (
            <p role="alert">
              Too many transactions arrived at once to read them all. The total
              shown is a minimum.
            </p>
          )}
          {guard.state === 'watching' && (
            <div className={styles.actions}>
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() =>
                  void run(async () =>
                    setGuard(
                      await call({ action: 'stop', revision: guard.revision }),
                    ),
                  )
                }
              >
                Stop watching
              </Button>
            </div>
          )}
          {guard.state === 'ended' && (
            <p>
              {guard.observation?.endReason === 'timed'
                ? 'Watch time ended without passing the limit.'
                : guard.observation?.endReason === 'capacity'
                  ? 'Stopped: too many transactions to keep tracking. Watch the chart manually.'
                  : 'Launch buys are complete and the limit was not passed.'}
            </p>
          )}
          {guard.state === 'stopped' && <p>You stopped Sniper Guard.</p>}
          {guard.state === 'triggered' && actions && (
            <div role="alert" className={styles.review}>
              <strong>Sniper Guard triggered. Nothing has been sold.</strong>
              {actions.stopRemainingBuys && (
                <p>
                  Complete Early: don&apos;t sign any remaining holder buys for
                  this launch.
                </p>
              )}
              {actions.sellWallets.length > 0 && (
                <>
                  <p>
                    Nuke: sell the full balance of these wallets now. Each sell
                    still needs your review and signature in the token
                    workspace.
                  </p>
                  <ul className={styles.history}>
                    {actions.sellWallets.map((wallet) => {
                      const balance = guard.observation?.balances?.find(
                        (b) => b.wallet === wallet,
                      );
                      return (
                        <li key={wallet}>
                          <code>{wallet}</code>
                          <span>
                            {wallet === launch?.developer ? 'Dev' : 'Holder'}
                            {balance
                              ? ` · ${sniperGuardDisplay(balance.amountRaw, 6)} tokens`
                              : ' · balance not read'}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {openTokenWorkspace &&
                  group &&
                  pumpLaunchWorkspaceReady(group) ? (
                    <Button
                      type="button"
                      disabled={locked}
                      onClick={() =>
                        void run(async () => {
                          const response = await fetch(
                            '/api/launch/pump/groups',
                            {
                              method: 'POST',
                              headers: { 'content-type': 'application/json' },
                              body: JSON.stringify({
                                action: 'token-workspace',
                                id: reviewId,
                              }),
                            },
                          );
                          if (!response.ok)
                            throw new Error(
                              'Token workspace did not open. Use Open token workspace and chart above.',
                            );
                          const result = parsePumpLaunchTokenWorkspace(
                            await readPanelJson(
                              response,
                              'Token workspace response is unavailable.',
                            ),
                            group,
                          );
                          openTokenWorkspace(result.project);
                        })
                      }
                    >
                      Open token workspace to sell
                    </Button>
                  ) : (
                    <p>
                      The token workspace opens once the launch is finalized and
                      recovered above. Until then, sell these wallets from your
                      wallet tools.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      <div aria-live="polite">
        {busy && <p>Working…</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
