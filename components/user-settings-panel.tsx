'use client';
import { createAuthClient } from 'better-auth/react';
import { useEffect, useState, type ReactNode } from 'react';
import { useUserSettings } from './use-user-settings';
import {
  activeThemeColors,
  exportTheme,
  importTheme,
  layoutHotkeys,
  THEME_COLOR_KEYS,
  THEME_PRESETS,
  validQuickAmount,
  writeUserSettings,
  type KeyboardLayout,
  type UserSettings,
} from '@/lib/user-settings';
import styles from './user-settings-panel.module.css';
import { TwoFactorSettings } from './two-factor-settings';

const auth = createAuthClient();
type SessionRow = {
  id: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  updatedAt: string | Date;
};

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className={styles.row}>
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className={styles.row} aria-label={label}>
      <strong>{label}</strong>
      <span className={styles.segment}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </span>
    </fieldset>
  );
}
function AmountList({
  label,
  values,
  suffix,
  max,
  onChange,
}: {
  label: string;
  values: string[];
  suffix: string;
  max?: number;
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState(values.join(', '));
  const [error, setError] = useState('');
  function commit() {
    const list = draft
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean);
    if (
      list.length < 1 ||
      list.length > 6 ||
      !list.every(validQuickAmount) ||
      (max !== undefined && list.some((v) => Number(v) > max))
    ) {
      setError(
        `Use 1 to 6 positive amounts with up to 4 decimals${max ? `, at most ${max}` : ''}.`,
      );
      return;
    }
    setError('');
    onChange(list);
  }
  return (
    <label className={styles.row}>
      <span>
        <strong>{label}</strong>
        <small>Comma separated, {suffix}</small>
      </span>
      <input
        className={styles.text}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        aria-invalid={Boolean(error)}
      />
      {error && (
        <small role="alert" className={styles.error}>
          {error}
        </small>
      )}
    </label>
  );
}

export function UserSettingsPanel({
  twoFactorAvailable = false,
}: {
  twoFactorAvailable?: boolean;
}) {
  const s = useUserSettings();
  const [themeJson, setThemeJson] = useState('');
  const [notice, setNotice] = useState('');
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionError, setSessionError] = useState('');
  const { data: session } = auth.useSession();
  const sessionToken = session?.session.token;
  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    void auth
      .listSessions()
      .then((r) => {
        if (cancelled) return;
        if (r.error || !r.data) setSessionError('Unable to list sessions.');
        else setSessions(r.data as SessionRow[]);
      })
      .catch(() => !cancelled && setSessionError('Unable to list sessions.'));
    return () => {
      cancelled = true;
    };
  }, [sessionToken]);
  if (!s) return null;
  const currentToken = sessionToken ?? '';
  const update = (next: UserSettings) => writeUserSettings(next);
  const set = <K extends keyof UserSettings>(
    key: K,
    patch: Partial<UserSettings[K]>,
  ) => update({ ...s, [key]: { ...(s[key] as object), ...patch } });
  const colors = activeThemeColors(s);
  async function revoke(token?: string) {
    setSessionError('');
    const r = token
      ? await auth.revokeSession({ token })
      : await auth.revokeOtherSessions();
    if (r.error) return setSessionError('Unable to end that session.');
    setSessions((list) =>
      (list ?? []).filter((x) =>
        token ? x.token !== token : x.token === currentToken,
      ),
    );
  }
  return (
    <div className={styles.panel}>
      <header>
        <p className={styles.eyebrow}>BUNDLE SETTINGS</p>
        <h1>Settings</h1>
        <p>
          Saved in this browser. These only change display and how many clicks a
          trade you start takes; signing still happens in your browser vault.
        </p>
      </header>

      <Section title="General">
        <Choice
          label="Balance preferences"
          value={s.general.balanceDisplay}
          options={[
            { value: 'Tokens', label: 'Token amount' },
            { value: 'SupplyPercent', label: '% of supply' },
          ]}
          onChange={(balanceDisplay) => set('general', { balanceDisplay })}
        />
        <Toggle
          label="Use Nuke value as holdings"
          hint="Holdings and unrealized P&L use the current Nuke (sell-all) value."
          checked={s.general.nukeValueAsHoldings}
          onChange={(nukeValueAsHoldings) =>
            set('general', { nukeValueAsHoldings })
          }
        />
      </Section>

      <Section title="Trade panel">
        <Toggle
          label="Instant Trade"
          hint="Quick amounts submit on click. Off: they only fill the amount until you press Buy or Sell."
          checked={s.tradePanel.instantTrade}
          onChange={(instantTrade) => set('tradePanel', { instantTrade })}
        />
        <Toggle
          label="Confirm dev trades"
          hint="Ask before trading from developer or deployer wallets."
          checked={s.tradePanel.confirmDevTrades}
          onChange={(confirmDevTrades) =>
            set('tradePanel', { confirmDevTrades })
          }
        />
        <Toggle
          label="Provider Racing"
          hint="Send each signed trade through the main RPC plus Solana's public RPC and Jito at once. Same signature, so it can only land once."
          checked={s.tradePanel.providerRacing}
          onChange={(providerRacing) => set('tradePanel', { providerRacing })}
        />
      </Section>

      <Section title="Wallet trades">
        <Toggle
          label="Individual instant buy / sell"
          hint="Adds one-click Buy and Sell buttons on each wallet row."
          checked={s.walletTrades.individualInstant}
          onChange={(individualInstant) =>
            set('walletTrades', { individualInstant })
          }
        />
        <AmountList
          key={`buy:${s.walletTrades.buyAmounts.join()}`}
          label="Buy quick amounts"
          suffix={s.walletTrades.unit === 'USD' ? 'USD' : 'SOL'}
          values={s.walletTrades.buyAmounts}
          onChange={(buyAmounts) => set('walletTrades', { buyAmounts })}
        />
        <AmountList
          key={`sell:${s.walletTrades.sellPercents.join()}`}
          label="Sell quick amounts"
          suffix="% of wallet balance"
          max={100}
          values={s.walletTrades.sellPercents}
          onChange={(sellPercents) => set('walletTrades', { sellPercents })}
        />
        <Choice
          label="Units"
          value={s.walletTrades.unit}
          options={[
            { value: 'Native', label: 'SOL' },
            { value: 'USD', label: 'USD' },
          ]}
          onChange={(unit) => set('walletTrades', { unit })}
        />
      </Section>

      <Section title="Nuke">
        <Toggle
          label="Confirmation"
          hint="Ask before Nuke runs."
          checked={s.nuke.confirmation}
          onChange={(confirmation) => set('nuke', { confirmation })}
        />
        <Toggle
          label="Include dev"
          hint="Add the developer wallet to Nuke."
          checked={s.nuke.includeDev}
          onChange={(includeDev) => set('nuke', { includeDev })}
        />
        <Toggle
          label="Consolidate supply"
          hint="Gather supply into one wallet before selling instead of selling wallet by wallet."
          checked={s.nuke.consolidate}
          onChange={(consolidate) => set('nuke', { consolidate })}
        />
      </Section>

      <Section title="Hotkeys">
        <Toggle
          label="Hotkeys"
          hint="Hold Space, then press a key to trade a quick amount in the trade panel."
          checked={s.hotkeys.enabled}
          onChange={(enabled) => set('hotkeys', { enabled })}
        />
        <Choice<KeyboardLayout>
          label="Keyboard layout"
          value={s.hotkeys.layout}
          options={(['QWERTY', 'AZERTY', 'QWERTZ'] as const).map((v) => ({
            value: v,
            label: v,
          }))}
          onChange={(layout) =>
            set('hotkeys', { layout, ...layoutHotkeys(layout) })
          }
        />
        <div className={styles.keys} aria-label="Hotkey bindings">
          {s.walletTrades.buyAmounts.map((a, i) => (
            <span key={`b${i}`}>
              <kbd>Space + {s.hotkeys.buyKeys[i].toUpperCase()}</kbd> Buy {a}
            </span>
          ))}
          {s.walletTrades.sellPercents.map((a, i) => (
            <span key={`s${i}`}>
              <kbd>Space + {s.hotkeys.sellKeys[i].toUpperCase()}</kbd> Sell {a}%
            </span>
          ))}
        </div>
      </Section>

      <Section title="Theme">
        <fieldset className={styles.presets} aria-label="Theme presets">
          {Object.keys(THEME_PRESETS).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={s.theme.preset === name}
              onClick={() => set('theme', { preset: name })}
              style={{
                background: THEME_PRESETS[name].background,
                color: THEME_PRESETS[name].text,
                borderColor: THEME_PRESETS[name].primary,
              }}
            >
              {name}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={s.theme.preset === 'Custom'}
            onClick={() =>
              set('theme', { preset: 'Custom', custom: { ...colors } })
            }
          >
            Edit theme
          </button>
        </fieldset>
        {s.theme.preset === 'Custom' && s.theme.custom && (
          <div className={styles.colors}>
            {THEME_COLOR_KEYS.map((k) => (
              <label key={k}>
                <input
                  type="color"
                  value={s.theme.custom![k]}
                  onChange={(e) =>
                    set('theme', {
                      custom: { ...s.theme.custom!, [k]: e.target.value },
                    })
                  }
                />
                {k}
              </label>
            ))}
          </div>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            onClick={async () => {
              const json = exportTheme(s);
              setThemeJson(json);
              try {
                await navigator.clipboard.writeText(json);
                setNotice('Theme JSON copied.');
              } catch {
                setNotice(
                  'Theme JSON is in the box below; copy it from there.',
                );
              }
            }}
          >
            Export
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                const custom = importTheme(themeJson);
                set('theme', { preset: 'Custom', custom });
                setNotice('Theme imported.');
              } catch (e) {
                setNotice((e as Error).message);
              }
            }}
          >
            Import
          </button>
        </div>
        <textarea
          className={styles.json}
          aria-label="Theme JSON"
          placeholder="Paste a Proxima or Axiom theme JSON, then press Import."
          value={themeJson}
          onChange={(e) => setThemeJson(e.target.value)}
        />
        {notice && <output>{notice}</output>}
        <Choice
          label="Style"
          value={s.theme.style}
          options={[
            { value: 'Modern', label: 'Modern' },
            { value: 'Classic', label: 'Classic' },
            { value: 'Rounded', label: 'Rounded' },
          ]}
          onChange={(style) => set('theme', { style })}
        />
      </Section>

      {twoFactorAvailable && (
        <Section title="Two-factor">
          <TwoFactorSettings />
        </Section>
      )}

      <Section title="Sessions">
        {!session ? (
          <p>Sign in to see your active devices.</p>
        ) : (
          <>
            {sessions === null && !sessionError && <p>Loading sessions…</p>}
            <ul className={styles.sessions}>
              {(sessions ?? []).map((x) => (
                <li key={x.id}>
                  <span>
                    <strong>
                      {x.token === currentToken ? 'This device' : 'Device'}
                    </strong>
                    <small>
                      {(x.userAgent ?? 'Unknown browser').slice(0, 80)} · last
                      active {new Date(x.updatedAt).toLocaleString()}
                    </small>
                  </span>
                  {x.token !== currentToken && (
                    <button type="button" onClick={() => void revoke(x.token)}>
                      Log out
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={(sessions?.length ?? 0) < 2}
              onClick={() => void revoke()}
            >
              Revoke all other sessions
            </button>
          </>
        )}
        {sessionError && <p role="alert">{sessionError}</p>}
      </Section>
    </div>
  );
}
