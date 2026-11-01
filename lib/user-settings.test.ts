import { describe, expect, it } from 'vitest';
import {
  defaultUserSettings,
  exportTheme,
  hotkeyAction,
  importTheme,
  isLightColor,
  normalizeUserSettings,
  THEME_PRESETS,
  themeCssVariables,
  validQuickAmount,
} from './user-settings';

describe('user settings', () => {
  it('falls back field by field on malformed input', () => {
    const s = normalizeUserSettings({
      tradePanel: { instantTrade: true, confirmDevTrades: 'yes' },
      walletTrades: { buyAmounts: ['0.12345'], sellPercents: ['150'] },
      theme: { preset: 'Nope', style: 'Rounded' },
    });
    const d = defaultUserSettings();
    expect(s.tradePanel).toEqual({
      instantTrade: true,
      confirmDevTrades: true,
    });
    expect(s.walletTrades.buyAmounts).toEqual(d.walletTrades.buyAmounts);
    expect(s.walletTrades.sellPercents).toEqual(d.walletTrades.sellPercents);
    expect(s.theme.preset).toBe('Proxima');
    expect(s.theme.style).toBe('Rounded');
    expect(normalizeUserSettings('garbage')).toEqual(d);
  });
  it('limits quick amounts to four decimals', () => {
    expect(validQuickAmount('0.0001')).toBe(true);
    expect(validQuickAmount('0.00001')).toBe(false);
    expect(validQuickAmount('0')).toBe(false);
    expect(validQuickAmount('-1')).toBe(false);
  });
  it('rejects duplicate hotkeys and uses the layout defaults', () => {
    const s = normalizeUserSettings({
      hotkeys: {
        enabled: true,
        layout: 'AZERTY',
        buyKeys: ['a', 'a', 'e', 'r', 't', 'y'],
        sellKeys: ['q', 's', 'd', 'f', 'g', 'h'],
      },
    });
    expect(s.hotkeys.buyKeys).toEqual(['a', 'z', 'e', 'r', 't', 'y']);
  });
  it('only fires hotkeys while Space is held and enabled', () => {
    const s = defaultUserSettings();
    expect(hotkeyAction(s, 'q', true)).toBeNull();
    s.hotkeys.enabled = true;
    expect(hotkeyAction(s, 'q', false)).toBeNull();
    expect(hotkeyAction(s, 'w', true)).toEqual({ side: 'Buy', index: 1 });
    expect(hotkeyAction(s, 'S', true)).toEqual({ side: 'Sell', index: 1 });
    // index beyond the configured amounts does nothing
    expect(hotkeyAction(s, 'y', true)).toBeNull();
  });
  it('round-trips theme JSON and maps Axiom-style aliases', () => {
    const s = defaultUserSettings();
    s.theme.preset = 'Terminal';
    expect(importTheme(exportTheme(s))).toEqual(THEME_PRESETS.Terminal);
    const axiom = importTheme(
      JSON.stringify({
        theme: {
          bg: '#000000',
          foreground: '#FFFFFF',
          accent: '#123456',
          border: '#222222',
        },
      }),
    );
    expect(axiom.background).toBe('#000000');
    expect(axiom.text).toBe('#ffffff');
    expect(axiom.primary).toBe('#123456');
    expect(() => importTheme('{"x":1}')).toThrow(/three/);
    expect(() => importTheme('not json')).toThrow(/valid/);
  });
  it('writes CSS variables and button radius for the style', () => {
    const s = defaultUserSettings();
    s.theme.style = 'Rounded';
    s.theme.preset = 'Light';
    const v = themeCssVariables(s);
    expect(v['--background']).toBe('#ffffff');
    expect(v['--bundle-button-radius']).toBe('999px');
    expect(isLightColor('#ffffff')).toBe(true);
    expect(isLightColor('#101114')).toBe(false);
  });
  it('custom preset without colours falls back', () => {
    expect(
      normalizeUserSettings({ theme: { preset: 'Custom' } }).theme.preset,
    ).toBe('Proxima');
  });
});
