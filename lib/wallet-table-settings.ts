// Wallet table column visibility, following the captured Proxima "Wallet Table
// Settings" modal: the address column is always shown, every metric column is
// toggled independently, and a reset restores all of them.
export const WALLET_TABLE_COLUMNS = [
  'balance',
  'volume',
  'pnl',
  'launches',
  'funding',
] as const;
export type WalletTableColumn = (typeof WALLET_TABLE_COLUMNS)[number];
export type WalletTableSettings = Record<WalletTableColumn, boolean>;

export const WALLET_TABLE_COLUMN_LABELS: Record<WalletTableColumn, string> = {
  balance: 'Balance',
  volume: 'Volume',
  pnl: 'P&L',
  launches: 'Launches',
  funding: 'Funding',
};

// The address column is not user-hideable, so it is listed separately.
export const WALLET_TABLE_ALWAYS_COLUMN = 'Wallet';
export const WALLET_TABLE_SETTINGS_KEY = 'bundle.wallet-table-settings.v1';

export const DEFAULT_WALLET_TABLE_SETTINGS: WalletTableSettings = Object.freeze(
  {
    balance: true,
    volume: true,
    pnl: true,
    launches: true,
    funding: true,
  },
);

function isColumn(value: string): value is WalletTableColumn {
  return (WALLET_TABLE_COLUMNS as readonly string[]).includes(value);
}

// Tolerant by design: a stored blob written by an older build may be missing
// columns or carry ones this build dropped. Unknown keys are ignored, absent
// ones fall back to visible, and only real booleans override the default.
export function parseWalletTableSettings(value: unknown): WalletTableSettings {
  const settings = { ...DEFAULT_WALLET_TABLE_SETTINGS };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return settings;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>))
    if (isColumn(key) && typeof raw === 'boolean') settings[key] = raw;
  return settings;
}

export function serializeWalletTableSettings(settings: WalletTableSettings) {
  return JSON.stringify(
    Object.fromEntries(
      WALLET_TABLE_COLUMNS.map((column) => [column, settings[column]]),
    ),
  );
}

export function countVisibleColumns(settings: WalletTableSettings) {
  return WALLET_TABLE_COLUMNS.filter((column) => settings[column]).length;
}
