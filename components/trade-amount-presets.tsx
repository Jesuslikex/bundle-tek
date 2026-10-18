'use client';
import { createAuthClient } from 'better-auth/react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  defaultTradeAmountPresets,
  presetPercentLabel,
  presetPercentToBps,
  requireTradeAmountPresets,
  tradePresetKeyboard,
  type TradeAmountPresets,
  type TradeAmountPreferenceView,
} from '@/lib/trade-amount-preferences';
import { tradeAmountPreferenceRequest } from '@/lib/trade-amount-preferences-client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { TradePresetKeyboardPanel } from './trade-preset-keyboard';
const auth = createAuthClient();
const changedEvent = 'bundle:trade-amount-presets';
export function useTradeAmountPresets() {
  const { data: session } = auth.useSession();
  const ownerId = session?.user.id ?? null;
  const [view, setView] = useState<TradeAmountPreferenceView | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const currentOwner = useRef(ownerId);
  useLayoutEffect(() => {
    currentOwner.current = ownerId;
  }, [ownerId]);
  const pending = useRef<AbortController | null>(null),
    source = useId();
  const [ownerContext, setOwnerContext] = useState(ownerId);
  if (ownerContext !== ownerId) {
    setOwnerContext(ownerId);
    setView(null);
    setError('');
    setBusy(false);
  }
  const perform = useCallback(
    async (save?: { revision: number; preferences: TradeAmountPresets }) => {
      pending.current?.abort();
      if (!ownerId) return null;
      const controller = new AbortController();
      pending.current = controller;
      try {
        const next = await tradeAmountPreferenceRequest(
          ownerId,
          controller.signal,
          save,
        );
        if (
          controller.signal.aborted ||
          currentOwner.current !== ownerId ||
          pending.current !== controller
        )
          return null;
        setView(next);
        if (save)
          window.dispatchEvent(
            new CustomEvent(changedEvent, { detail: { ownerId, source } }),
          );
        return next;
      } catch (e) {
        if (pending.current === controller && currentOwner.current === ownerId)
          setError(
            e instanceof Error ? e.message : 'Saved presets unavailable.',
          );
        return null;
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          setBusy(false);
        }
      }
    },
    [ownerId, source],
  );
  function load(save?: { revision: number; preferences: TradeAmountPresets }) {
    if (!ownerId) {
      setError('Sign in to save amount presets.');
      return Promise.resolve(null);
    }
    setBusy(true);
    setError('');
    return perform(save);
  }
  useEffect(() => {
    let active = true;
    // Let cleanup suppress an obsolete initial read, including StrictMode remounts.
    queueMicrotask(() => {
      if (active && ownerId) void perform();
    });
    const refresh = (event: Event) => {
      const d = (event as CustomEvent<{ ownerId?: string; source?: string }>)
        .detail;
      if (d?.ownerId === ownerId && d.source !== source) void perform();
    };
    window.addEventListener(changedEvent, refresh);
    return () => {
      active = false;
      window.removeEventListener(changedEvent, refresh);
      const controller = pending.current;
      pending.current = null;
      controller?.abort();
    };
  }, [ownerId, source, perform]);
  const owned = view?.ownerId === ownerId ? view : null;
  return {
    ownerId,
    view: owned,
    preferences: owned?.preferences ?? defaultTradeAmountPresets(),
    busy: busy || Boolean(ownerId && !owned && !error),
    error,
    reload: () => load(),
    save: (preferences: TradeAmountPresets, revision: number) =>
      load({ preferences, revision }),
  };
}
type Store = ReturnType<typeof useTradeAmountPresets>;
const fields = (p: TradeAmountPresets) => ({
  buySol: [...p.buySol],
  sellBalance: p.sellBalanceBps.map((n) => presetPercentLabel(n).slice(0, -1)),
  sellSupply: p.sellSupplyBps.map((n) => presetPercentLabel(n).slice(0, -1)),
  keyboard: tradePresetKeyboard(p),
});
function PresetEditor({ store }: { store: Store }) {
  const [draft, setDraft] = useState(() => fields(store.preferences)),
    [base, setBase] = useState(store.view?.revision ?? null),
    [dirty, setDirty] = useState(false),
    [message, setMessage] = useState('');
  const [seenRevision, setSeenRevision] = useState(
    store.view?.revision ?? null,
  );
  if (!dirty && store.view && seenRevision !== store.view.revision) {
    setSeenRevision(store.view.revision);
    setDraft(fields(store.view.preferences));
    setBase(store.view.revision);
  }
  const conflict =
    dirty &&
    base !== null &&
    store.view !== null &&
    base !== store.view.revision;
  async function save() {
    if (!store.ownerId || base === null || store.busy || conflict) return;
    setMessage('');
    try {
      const preferences = requireTradeAmountPresets({
        format: 'trade-amount-presets-v2',
        buySol: draft.buySol,
        sellBalanceBps: draft.sellBalance.map(presetPercentToBps),
        sellSupplyBps: draft.sellSupply.map(presetPercentToBps),
        keyboard: draft.keyboard,
      });
      const next = await store.save(preferences, base);
      if (next) {
        setDraft(fields(next.preferences));
        setBase(next.revision);
        setDirty(false);
        setMessage('Amount presets saved. No trade was started.');
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Check the preset values.');
    }
  }
  return (
    <div>
      <p>
        Save 1 to 8 shortcuts per amount type for this account. Selecting a
        shortcut fills an amount for review.
      </p>
      {(['buySol', 'sellBalance', 'sellSupply'] as const).map((kind) => {
        const label = {
          buySol: 'Buy SOL',
          sellBalance: 'Sell balance %',
          sellSupply: 'Sell saved supply %',
        }[kind];
        return (
          <fieldset key={kind} className="my-3">
            <legend>{label}</legend>
            {draft[kind].map((value, index) => (
              <div className="flex min-w-0 gap-2 my-1" key={index}>
                <Input
                  aria-label={`${label} preset ${index + 1}`}
                  value={value}
                  inputMode="decimal"
                  disabled={store.busy}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      [kind]: draft[kind].map((v, i) =>
                        i === index ? event.target.value : v,
                      ),
                    });
                    setDirty(true);
                    setMessage('');
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={store.busy || draft[kind].length === 1}
                  aria-label={`Remove ${label} preset ${index + 1}`}
                  onClick={() => {
                    setDraft({
                      ...draft,
                      [kind]: draft[kind].filter((_, i) => i !== index),
                    });
                    setDirty(true);
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              disabled={store.busy || draft[kind].length >= 8}
              onClick={() => {
                setDraft({ ...draft, [kind]: [...draft[kind], ''] });
                setDirty(true);
              }}
            >
              Add {label} preset
            </Button>
          </fieldset>
        );
      })}
      <details>
        <summary>Customize preset keys</summary>
        <p>
          One lowercase letter or digit per position. Blank disables a position.
          Keys must be unique across all lists. Enable keys separately in each
          panel; they only fill amounts.
        </p>
        {(['buy', 'sellBalance', 'sellSupply'] as const).map((kind) => {
          const label = {
            buy: 'Buy SOL',
            sellBalance: 'Sell balance %',
            sellSupply: 'Sell saved supply %',
          }[kind];
          return (
            <fieldset key={kind} className="my-3">
              <legend>{label} keys</legend>
              <div className="grid grid-cols-2 gap-2">
                {draft.keyboard[kind].map((key, index) => (
                  <label key={index}>
                    Position {index + 1}
                    <Input
                      aria-label={`${label} key ${index + 1}`}
                      value={key}
                      maxLength={1}
                      autoComplete="off"
                      disabled={store.busy}
                      onChange={(event) => {
                        setDraft({
                          ...draft,
                          keyboard: {
                            ...draft.keyboard,
                            [kind]: draft.keyboard[kind].map((v, i) =>
                              i === index
                                ? event.target.value.toLowerCase()
                                : v,
                            ),
                          },
                        });
                        setDirty(true);
                        setMessage('');
                      }}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </details>
      {conflict && (
        <p role="alert">
          Presets changed in another tab. Reload saved presets before saving
          these edits.
        </p>
      )}
      {!store.ownerId && <p>Sign in to save amount presets.</p>}
      {store.error && <p role="alert">{store.error}</p>}
      {message && <output>{message}</output>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={
            !store.ownerId || store.busy || base === null || !dirty || conflict
          }
          onClick={() => void save()}
        >
          Save amount presets
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!store.ownerId || store.busy}
          onClick={() =>
            void store.reload().then((next) => {
              if (next) {
                setDraft(fields(next.preferences));
                setBase(next.revision);
                setDirty(false);
                setMessage('Loaded saved presets.');
              }
            })
          }
        >
          Reload saved presets
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={store.busy}
          onClick={() => {
            setDraft(fields(defaultTradeAmountPresets()));
            setBase(store.view?.revision ?? null);
            setDirty(true);
            setMessage('Default values filled. Save to keep them.');
          }}
        >
          Use Bundle defaults
        </Button>
      </div>
    </div>
  );
}
export function TradeAmountPresetSettings({ store }: { store: Store }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Customize amount presets</summary>
      {open && (
        <PresetEditor key={store.ownerId ?? 'signed-out'} store={store} />
      )}
    </details>
  );
}
export function BuyAmountPresets({
  disabled,
  onAmountChange,
  contextKey = 'standalone',
}: {
  disabled: boolean;
  onAmountChange: (value: string) => void;
  contextKey?: string;
}) {
  const store = useTradeAmountPresets();
  return (
    <section aria-label="Buy amount presets">
      <p className="text-xs text-muted-foreground">
        {store.view
          ? 'Saved amount presets'
          : store.busy
            ? 'Loading saved presets…'
            : 'Default amount presets'}{' '}
        · fills the amount only.
      </p>
      <TradePresetKeyboardPanel
        label="Buy preset keyboard panel"
        scope={JSON.stringify([
          contextKey,
          store.ownerId,
          store.view?.revision,
          store.preferences,
        ])}
        blocked={disabled || store.busy || Boolean(store.error)}
        actions={store.preferences.buySol.map((amount, index) => ({
          key: tradePresetKeyboard(store.preferences).buy[index],
          label: `${amount} SOL`,
          disabled,
          select: () => {
            if (!disabled) onAmountChange(amount);
          },
        }))}
      >
        <div className="flex flex-wrap gap-2">
          {store.preferences.buySol.map((amount) => (
            <Button
              type="button"
              key={amount}
              variant="outline"
              disabled={disabled}
              aria-label={`Set buy amount to ${amount} SOL`}
              onClick={() => {
                if (!disabled) onAmountChange(amount);
              }}
            >
              {amount} SOL
            </Button>
          ))}
        </div>
      </TradePresetKeyboardPanel>
      <TradeAmountPresetSettings store={store} />
    </section>
  );
}
