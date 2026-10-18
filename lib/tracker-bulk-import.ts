import {
  MAX_TRACKED_WALLETS,
  validateTrackedWallet,
  type TrackedWallet,
} from './tracked-wallet';

export type TrackerImportWallet = ReturnType<typeof validateTrackedWallet>;
export type TrackerImportDefaults = Omit<TrackerImportWallet, 'address'>;
export type TrackerImportReview = ReturnType<typeof reviewTrackerImport>;

/** Parse only public watchlist fields. Never forward an imported object verbatim. */
export function reviewTrackerImport(
  text: string,
  defaults: TrackerImportDefaults,
  existing: TrackedWallet[],
) {
  if (text.length > 20_000)
    throw new Error(
      'Watchlist text exceeds 20,000 characters. Split the batch.',
    );
  const source = text.trim();
  const format =
    source.startsWith('[') || source.startsWith('{') ? 'JSON' : 'Address list';
  let entries: unknown[];
  if (format === 'JSON') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error('Use a valid JSON array of public wallet entries.');
    }
    if (!Array.isArray(parsed))
      throw new Error('Use a JSON array, not an object or wrapped export.');
    entries = parsed;
  } else {
    entries = source
      .split(/[,\r\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!entries.length || entries.length > MAX_TRACKED_WALLETS)
    throw new Error('Preview between 1 and 100 public addresses.');

  const seen = new Map<string, number>();
  const parsed = entries.map((entry, index) => {
    const row = index + 1;
    let candidate: unknown;
    if (typeof entry === 'string') {
      candidate = { ...defaults, address: entry };
    } else {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error(`Row ${row}: use a public address or wallet object.`);
      const record = entry as Record<string, unknown>;
      if (
        Object.keys(record).some(
          (key) => !['address', 'name', 'icon', 'bookmark'].includes(key),
        )
      )
        throw new Error(
          `Row ${row}: unsupported fields. Use only address, name, icon and bookmark.`,
        );
      candidate = {
        ...defaults,
        address: record.address,
        label: record.name === undefined ? defaults.label : record.name,
        icon: record.icon === undefined ? defaults.icon : record.icon,
        favorite:
          record.bookmark === undefined ? defaults.favorite : record.bookmark,
      };
    }
    let wallet: TrackerImportWallet;
    try {
      wallet = validateTrackedWallet(candidate);
    } catch (error) {
      throw new Error(
        `Row ${row}: ${error instanceof Error ? error.message : 'Invalid public wallet.'}`,
      );
    }
    const identity = `${wallet.network}:${wallet.address}`;
    const previous = seen.get(identity);
    if (previous !== undefined)
      throw new Error(
        `Row ${row}: duplicate of row ${previous}. Remove the duplicate before saving.`,
      );
    seen.set(identity, row);
    return wallet;
  });
  const saved = new Map(
    existing.map((wallet) => [`${wallet.network}:${wallet.address}`, wallet]),
  );
  let skipped = 0,
    archivedSkipped = 0;
  const wallets = parsed.filter((wallet) => {
    const match = saved.get(`${wallet.network}:${wallet.address}`);
    if (!match) return true;
    skipped++;
    if (match.archived) archivedSkipped++;
    return false;
  });
  if (existing.length + wallets.length > MAX_TRACKED_WALLETS)
    throw new Error(
      `This batch needs ${wallets.length} new slots, but only ${Math.max(0, MAX_TRACKED_WALLETS - existing.length)} remain. Archived entries also count toward the 100-wallet limit.`,
    );
  if (JSON.stringify({ action: 'add', wallets }).length > 20_000)
    throw new Error(
      'The reviewed request exceeds 20,000 characters. Split the batch or shorten its metadata.',
    );
  return { format, total: parsed.length, wallets, skipped, archivedSkipped };
}
