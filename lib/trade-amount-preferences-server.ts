import {
  defaultTradeAmountPresets,
  requireTradeAmountPresets,
  type TradeAmountPreferenceView,
} from './trade-amount-preferences';
export class TradePreferenceError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const scope = (owner: string) => {
  if (!owner || owner.length > 128)
    throw new TradePreferenceError('Sign in to load saved presets.', 401);
};
type Row = { revision: number; document: string; updated_at: string };
function decode(ownerId: string, row: Row | null): TradeAmountPreferenceView {
  if (!row)
    return {
      ownerId,
      revision: 0,
      preferences: defaultTradeAmountPresets(),
      updatedAt: null,
    };
  const preferences = requireTradeAmountPresets(JSON.parse(row.document));
  if (
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    row.revision > 1e9 ||
    JSON.stringify(preferences) !== row.document ||
    typeof row.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(row.updated_at)) ||
    new Date(row.updated_at).toISOString() !== row.updated_at
  )
    throw Error('Saved preset record differs.');
  return {
    ownerId,
    revision: row.revision,
    preferences,
    updatedAt: row.updated_at,
  };
}
const row = (db: D1Database, owner: string) =>
  db
    .prepare(
      'SELECT revision,document,updated_at FROM trade_amount_preferences WHERE owner_id=?',
    )
    .bind(owner)
    .first<Row>();
export async function readTradeAmountPreferences(
  db: D1Database,
  owner: string,
) {
  scope(owner);
  return decode(owner, await row(db, owner));
}
export async function saveTradeAmountPreferences(
  db: D1Database,
  owner: string,
  revision: number,
  value: unknown,
) {
  scope(owner);
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 1e9)
    throw new TradePreferenceError('Reload presets before saving.', 400);
  let document: string;
  try {
    document = JSON.stringify(requireTradeAmountPresets(value));
  } catch {
    throw new TradePreferenceError(
      'Choose 1 to 8 distinct positive SOL amounts or percentages per list.',
      400,
    );
  }
  const write =
    revision === 0
      ? db
          .prepare(
            "INSERT INTO trade_amount_preferences(owner_id,revision,document,created_at,updated_at) VALUES(?,1,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(owner_id) DO NOTHING",
          )
          .bind(owner, document)
      : db
          .prepare(
            "UPDATE trade_amount_preferences SET revision=revision+1,document=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND revision=?",
          )
          .bind(document, owner, revision);
  const results = await db.batch([
    write,
    db
      .prepare(
        'SELECT revision,document,updated_at FROM trade_amount_preferences WHERE owner_id=?',
      )
      .bind(owner),
  ]);
  if (!results[0].meta.changes)
    throw new TradePreferenceError(
      'Presets changed in another tab or the last save finished. Reload presets before saving again.',
    );
  const saved = decode(owner, (results[1].results[0] as Row) ?? null);
  if (
    saved.revision !== revision + 1 ||
    JSON.stringify(saved.preferences) !== document
  )
    throw Error('Saved preset write differs.');
  return saved;
}
