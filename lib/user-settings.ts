// Per-browser display and trade-panel preferences (Proxima "Settings").
// Nothing here grants signing authority: every flag only changes what the UI
// shows or how many clicks a user-initiated trade takes.

export const USER_SETTINGS_KEY = 'bundle-user-settings-v1';
export const USER_SETTINGS_EVENT = 'bundle-user-settings-changed';

export const THEME_COLOR_KEYS = [
  'primary',
  'secondary',
  'background',
  'text',
  'stroke',
  'action',
  'chartUp',
  'chartDown',
  'success',
  'warning',
  'danger',
] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
export type ThemeColors = Record<ThemeColorKey, string>;
export type ButtonStyle = 'Modern' | 'Classic' | 'Rounded';
export type KeyboardLayout = 'QWERTY' | 'AZERTY' | 'QWERTZ';
export type AmountUnit = 'Native' | 'USD';
export type BalanceDisplay = 'Tokens' | 'SupplyPercent';

export type UserSettings = {
  version: 1;
  general: { balanceDisplay: BalanceDisplay; nukeValueAsHoldings: boolean };
  tradePanel: { instantTrade: boolean; confirmDevTrades: boolean };
  walletTrades: {
    individualInstant: boolean;
    buyAmounts: string[];
    sellPercents: string[];
    unit: AmountUnit;
  };
  nuke: { confirmation: boolean; includeDev: boolean; consolidate: boolean };
  hotkeys: {
    enabled: boolean;
    layout: KeyboardLayout;
    buyKeys: string[];
    sellKeys: string[];
  };
  theme: { preset: string; custom: ThemeColors | null; style: ButtonStyle };
};

export const THEME_PRESETS: Record<string, ThemeColors> = {
  Proxima: {
    primary: '#7892ff',
    secondary: '#18181f',
    background: '#101114',
    text: '#fcfcfc',
    stroke: '#22242d',
    action: '#7892ff',
    chartUp: '#2ebd85',
    chartDown: '#ed3a7a',
    success: '#2ebd85',
    warning: '#f5a524',
    danger: '#ed3a7a',
  },
  Midnight: {
    primary: '#a78bfa',
    secondary: '#141226',
    background: '#0b0a17',
    text: '#f4f2ff',
    stroke: '#262342',
    action: '#a78bfa',
    chartUp: '#34d399',
    chartDown: '#f87171',
    success: '#34d399',
    warning: '#fbbf24',
    danger: '#f87171',
  },
  Terminal: {
    primary: '#22c55e',
    secondary: '#0f1410',
    background: '#060906',
    text: '#d9f99d',
    stroke: '#1c2a1e',
    action: '#22c55e',
    chartUp: '#22c55e',
    chartDown: '#ef4444',
    success: '#22c55e',
    warning: '#eab308',
    danger: '#ef4444',
  },
  Light: {
    primary: '#3b5bdb',
    secondary: '#f1f3f5',
    background: '#ffffff',
    text: '#111318',
    stroke: '#dee2e6',
    action: '#3b5bdb',
    chartUp: '#0ca678',
    chartDown: '#e03131',
    success: '#0ca678',
    warning: '#f08c00',
    danger: '#e03131',
  },
};

const LAYOUT_KEYS: Record<KeyboardLayout, { buy: string; sell: string }> = {
  QWERTY: { buy: 'qwerty', sell: 'asdfgh' },
  AZERTY: { buy: 'azerty', sell: 'qsdfgh' },
  QWERTZ: { buy: 'qwertz', sell: 'asdfgh' },
};
export const layoutHotkeys = (layout: KeyboardLayout) => ({
  buyKeys: LAYOUT_KEYS[layout].buy.split(''),
  sellKeys: LAYOUT_KEYS[layout].sell.split(''),
});

export function defaultUserSettings(): UserSettings {
  return {
    version: 1,
    general: { balanceDisplay: 'Tokens', nukeValueAsHoldings: false },
    tradePanel: { instantTrade: false, confirmDevTrades: true },
    walletTrades: {
      individualInstant: false,
      buyAmounts: ['0.1', '0.25', '0.5', '1'],
      sellPercents: ['25', '50', '75', '100'],
      unit: 'Native',
    },
    nuke: { confirmation: true, includeDev: false, consolidate: false },
    hotkeys: { enabled: false, layout: 'QWERTY', ...layoutHotkeys('QWERTY') },
    theme: { preset: 'Proxima', custom: null, style: 'Modern' },
  };
}

const HEX = /^#[0-9a-f]{6}$/i;
const AMOUNT = /^(0|[1-9]\d{0,8})(\.\d{1,4})?$/;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const pick = <T extends string>(v: unknown, opts: readonly T[], d: T) =>
  opts.includes(v as T) ? (v as T) : d;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** A quick amount: positive, at most four decimal places (Proxima's limit). */
export function validQuickAmount(value: string) {
  return AMOUNT.test(value) && Number(value) > 0;
}
function amounts(v: unknown, d: string[], max?: number) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 6) return d;
  const out = v.map(String);
  if (!out.every(validQuickAmount)) return d;
  if (max !== undefined && out.some((a) => Number(a) > max)) return d;
  return out;
}
function keys(v: unknown, d: string[]) {
  if (
    !Array.isArray(v) ||
    v.length !== 6 ||
    !v.every((k) => typeof k === 'string' && /^[a-z0-9]$/.test(k))
  )
    return d;
  return v as string[];
}
export function parseThemeColors(v: unknown): ThemeColors | null {
  const o = obj(v);
  const out = {} as ThemeColors;
  for (const k of THEME_COLOR_KEYS) {
    if (typeof o[k] !== 'string' || !HEX.test(o[k] as string)) return null;
    out[k] = (o[k] as string).toLowerCase();
  }
  return out;
}

/** Tolerant reader: anything malformed falls back to the default field. */
export function normalizeUserSettings(raw: unknown): UserSettings {
  const d = defaultUserSettings();
  const r = obj(raw);
  const g = obj(r.general),
    t = obj(r.tradePanel),
    w = obj(r.walletTrades),
    n = obj(r.nuke),
    h = obj(r.hotkeys),
    th = obj(r.theme);
  const layout = pick(h.layout, ['QWERTY', 'AZERTY', 'QWERTZ'], 'QWERTY');
  const lk = layoutHotkeys(layout);
  let buyKeys = keys(h.buyKeys, lk.buyKeys),
    sellKeys = keys(h.sellKeys, lk.sellKeys);
  if (new Set([...buyKeys, ...sellKeys]).size !== 12) {
    buyKeys = lk.buyKeys;
    sellKeys = lk.sellKeys;
  }
  const preset =
    typeof th.preset === 'string' &&
    (th.preset === 'Custom' || th.preset in THEME_PRESETS)
      ? th.preset
      : d.theme.preset;
  const custom = parseThemeColors(th.custom);
  return {
    version: 1,
    general: {
      balanceDisplay: pick(
        g.balanceDisplay,
        ['Tokens', 'SupplyPercent'],
        'Tokens',
      ),
      nukeValueAsHoldings: bool(g.nukeValueAsHoldings, false),
    },
    tradePanel: {
      instantTrade: bool(t.instantTrade, false),
      confirmDevTrades: bool(t.confirmDevTrades, true),
    },
    walletTrades: {
      individualInstant: bool(w.individualInstant, false),
      buyAmounts: amounts(w.buyAmounts, d.walletTrades.buyAmounts),
      sellPercents: amounts(w.sellPercents, d.walletTrades.sellPercents, 100),
      unit: pick(w.unit, ['Native', 'USD'], 'Native'),
    },
    nuke: {
      confirmation: bool(n.confirmation, true),
      includeDev: bool(n.includeDev, false),
      consolidate: bool(n.consolidate, false),
    },
    hotkeys: { enabled: bool(h.enabled, false), layout, buyKeys, sellKeys },
    theme: {
      preset: preset === 'Custom' && !custom ? d.theme.preset : preset,
      custom,
      style: pick(th.style, ['Modern', 'Classic', 'Rounded'], 'Modern'),
    },
  };
}

export function activeThemeColors(s: UserSettings): ThemeColors {
  return s.theme.preset === 'Custom' && s.theme.custom
    ? s.theme.custom
    : (THEME_PRESETS[s.theme.preset] ?? THEME_PRESETS.Proxima);
}

/** Proxima-style theme JSON: {"name": ..., "colors": {...}}. */
export function exportTheme(s: UserSettings) {
  return JSON.stringify(
    {
      format: 'proxima-theme',
      name: s.theme.preset,
      colors: activeThemeColors(s),
    },
    null,
    2,
  );
}

// Axiom/Proxima exports use differing key names; map the common aliases.
const ALIASES: Record<string, ThemeColorKey> = {
  primary: 'primary',
  accent: 'primary',
  secondary: 'secondary',
  surface: 'secondary',
  card: 'secondary',
  background: 'background',
  bg: 'background',
  text: 'text',
  foreground: 'text',
  stroke: 'stroke',
  border: 'stroke',
  action: 'action',
  button: 'action',
  chartup: 'chartUp',
  chart_up: 'chartUp',
  increase: 'chartUp',
  chartdown: 'chartDown',
  chart_down: 'chartDown',
  decrease: 'chartDown',
  success: 'success',
  positive: 'success',
  warning: 'warning',
  danger: 'danger',
  error: 'danger',
  negative: 'danger',
};
export function importTheme(json: string): ThemeColors {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw Error('Paste valid theme JSON.');
  }
  const root = obj(parsed);
  const source = obj(root.colors ?? root.theme ?? root);
  const base = { ...THEME_PRESETS.Proxima };
  let matched = 0;
  for (const [key, value] of Object.entries(source)) {
    const target = ALIASES[key.toLowerCase()];
    if (target && typeof value === 'string' && HEX.test(value.trim())) {
      base[target] = value.trim().toLowerCase();
      matched++;
    }
  }
  if (matched < 3)
    throw Error('That JSON has fewer than three recognised hex colours.');
  return base;
}

export function readUserSettings(): UserSettings {
  try {
    const raw = window.localStorage.getItem(USER_SETTINGS_KEY);
    return normalizeUserSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultUserSettings();
  }
}
export function writeUserSettings(s: UserSettings) {
  try {
    window.localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: the setting still applies for this page view */
  }
  window.dispatchEvent(new CustomEvent(USER_SETTINGS_EVENT, { detail: s }));
}

const RADIUS: Record<ButtonStyle, string> = {
  Modern: '6px',
  Classic: '2px',
  Rounded: '999px',
};
/** CSS custom properties written onto <html>. */
export function themeCssVariables(s: UserSettings): Record<string, string> {
  const c = activeThemeColors(s);
  return {
    '--background': c.background,
    '--foreground': c.text,
    '--card': c.secondary,
    '--primary': c.primary,
    '--border': c.stroke,
    '--bundle-action': c.action,
    '--bundle-chart-up': c.chartUp,
    '--bundle-chart-down': c.chartDown,
    '--bundle-success': c.success,
    '--bundle-warning': c.warning,
    '--bundle-danger': c.danger,
    '--bundle-button-radius': RADIUS[s.theme.style],
  };
}
export function applyUserTheme(s: UserSettings, root: HTMLElement) {
  for (const [k, v] of Object.entries(themeCssVariables(s)))
    root.style.setProperty(k, v);
  root.dataset.buttonStyle = s.theme.style.toLowerCase();
  root.classList.toggle('dark', !isLightColor(activeThemeColors(s).background));
}
export function isLightColor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

/** Hotkey lookup: Space must be held; returns the preset index or null. */
export function hotkeyAction(
  s: UserSettings,
  key: string,
  spaceHeld: boolean,
): { side: 'Buy' | 'Sell'; index: number } | null {
  if (!s.hotkeys.enabled || !spaceHeld) return null;
  const k = key.toLowerCase();
  const b = s.hotkeys.buyKeys.indexOf(k);
  if (b >= 0 && b < s.walletTrades.buyAmounts.length)
    return { side: 'Buy', index: b };
  const sl = s.hotkeys.sellKeys.indexOf(k);
  if (sl >= 0 && sl < s.walletTrades.sellPercents.length)
    return { side: 'Sell', index: sl };
  return null;
}
