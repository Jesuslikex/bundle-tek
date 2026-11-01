// Selection rules for the captured Proxima "CEX Funding Sources" modal.
// The reference only ever offers sources that are available AND served by the
// husher provider, shows a running "selected/total" count, and has a Select All
// row. The source catalog itself comes from the server, so it is passed in.
export const CEX_FUNDING_PROVIDER = 'husher';

export type CexFundingSource = {
  id: string;
  name: string;
  available: boolean;
  provider: string;
};

// A source can only be offered when it is available on this chain and comes
// from the expected provider; anything else is listed but unselectable.
export function selectableCexSources(sources: readonly CexFundingSource[]) {
  return sources.filter(
    (source) => source.available && source.provider === CEX_FUNDING_PROVIDER,
  );
}

// Drop ids the current catalog no longer offers, keeping catalog order so the
// selection is stable regardless of click order.
export function reconcileCexSelection(
  selected: readonly string[],
  sources: readonly CexFundingSource[],
) {
  const offered = selectableCexSources(sources);
  return offered
    .filter((source) => selected.includes(source.id))
    .map((source) => source.id);
}

export function toggleCexSource(
  selected: readonly string[],
  id: string,
  sources: readonly CexFundingSource[],
) {
  return selected.includes(id)
    ? selected.filter((value) => value !== id)
    : reconcileCexSelection([...selected, id], sources);
}

// Select All selects every offered source, or clears when all are already on.
export function toggleAllCexSources(
  selected: readonly string[],
  sources: readonly CexFundingSource[],
) {
  const offered = selectableCexSources(sources);
  return selected.length === offered.length
    ? []
    : offered.map((source) => source.id);
}

export function cexSelectionLabel(selected: readonly string[], total: number) {
  return `${selected.length}/${total}`;
}

export function cexSelectionReady(
  selected: readonly string[],
  sources: readonly CexFundingSource[],
) {
  return reconcileCexSelection(selected, sources).length > 0;
}
