import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WALLET_TABLE_SETTINGS,
  WALLET_TABLE_COLUMNS,
  countVisibleColumns,
  parseWalletTableSettings,
  serializeWalletTableSettings,
} from './wallet-table-settings';

describe('wallet table settings', () => {
  it('shows every metric column by default', () => {
    expect(DEFAULT_WALLET_TABLE_SETTINGS).toEqual({
      balance: true,
      volume: true,
      pnl: true,
      launches: true,
      funding: true,
    });
    expect(countVisibleColumns(DEFAULT_WALLET_TABLE_SETTINGS)).toBe(5);
  });

  it('never mutates the frozen defaults', () => {
    const settings = parseWalletTableSettings(null);
    settings.balance = false;
    expect(DEFAULT_WALLET_TABLE_SETTINGS.balance).toBe(true);
    expect(settings.balance).toBe(false);
  });

  it('falls back to the defaults for unusable input', () => {
    for (const value of [null, undefined, 7, 'text', [], true])
      expect(parseWalletTableSettings(value)).toEqual(
        DEFAULT_WALLET_TABLE_SETTINGS,
      );
  });

  it('honours real booleans and ignores everything else', () => {
    expect(
      parseWalletTableSettings({
        balance: false,
        volume: true,
        pnl: 'yes',
        unknown: false,
        launches: 0,
        funding: false,
      }),
    ).toEqual({
      balance: false,
      volume: true,
      // A non-boolean keeps the visible default rather than coercing.
      pnl: true,
      launches: true,
      funding: false,
    });
  });

  it('restores absent columns to visible, so a stale blob cannot hide them', () => {
    expect(parseWalletTableSettings({ pnl: false })).toEqual({
      ...DEFAULT_WALLET_TABLE_SETTINGS,
      pnl: false,
    });
  });

  it('round-trips through the serialized form', () => {
    const settings = parseWalletTableSettings({
      volume: false,
      funding: false,
    });
    expect(
      parseWalletTableSettings(
        JSON.parse(serializeWalletTableSettings(settings)),
      ),
    ).toEqual(settings);
  });

  it('serializes only known columns in a stable order', () => {
    const text = serializeWalletTableSettings({
      ...DEFAULT_WALLET_TABLE_SETTINGS,
      volume: false,
    });
    expect(Object.keys(JSON.parse(text))).toEqual([...WALLET_TABLE_COLUMNS]);
    expect(text).toBe(
      '{"balance":true,"volume":false,"pnl":true,"launches":true,"funding":true}',
    );
  });

  it('can reach a state with nothing visible', () => {
    const none = parseWalletTableSettings({
      balance: false,
      volume: false,
      pnl: false,
      launches: false,
      funding: false,
    });
    expect(countVisibleColumns(none)).toBe(0);
  });
});
