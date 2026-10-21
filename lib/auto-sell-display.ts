import type { AutoSellLogEntry } from './auto-sell-runner';

/** Presentation only. Preserve the original engine reasons and accounting. */
export function autoSellEndLabel(reason: string | null, fallback: string) {
  if (reason === 'Max amount sold') return 'Maximum accounted amount reached';
  if (reason === 'All limit orders filled')
    return 'All limit targets processed';
  return reason ?? fallback;
}

export function autoSellActivityLabel(entry: AutoSellLogEntry) {
  if (entry.kind === 'sell')
    return (
      entry.text.replace(
        /: sold (\d+) raw from ([^\s:.]+)\.$/,
        ': submitted $1 raw from $2.',
      ) + ' Finality not verified.'
    );
  if (entry.kind === 'info')
    return entry.text
      .replace(
        ' ended: Max amount sold.',
        ' ended: Maximum accounted amount reached.',
      )
      .replace(
        ' ended: All limit orders filled.',
        ' ended: All limit targets processed.',
      );
  return entry.text;
}
