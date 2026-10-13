export class ConditionalBuyStorageUnavailable extends Error {
  constructor() {
    super(
      'Conditional Buy storage is not upgraded. No provider work or signing is allowed.',
    );
  }
}
export async function requireConditionalBuyStorage(db: D1Database) {
  const capability = await db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='conditional_buy_approval_capability'",
    )
    .first();
  if (!capability) throw new ConditionalBuyStorageUnavailable();
}
