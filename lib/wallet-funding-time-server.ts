import {
  validatedNativeWithdrawal,
  type NativeWithdrawal,
} from './native-withdrawal';
import {
  walletFundingSelection,
  walletFundingTimes,
  type WalletFundingTimes,
} from './wallet-funding-time';
export class WalletFundingTimeError extends Error {
  constructor(readonly status: number) {
    super('Recorded funding times unavailable.');
  }
}
type Row = {
  id: string;
  wallet: string;
  walletRevision: number;
  state: NativeWithdrawal['state'];
  signature: string | null;
  document: string;
  receipt: string | null;
  createdAt: string;
  updatedAt: string;
  recipient: string;
};
export async function readWalletFundingTimes(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  now = Date.now(),
): Promise<WalletFundingTimes> {
  const { wallets } = walletFundingSelection.parse(value);
  const addresses = JSON.stringify(wallets.map((wallet) => wallet.address));
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
    throw new WalletFundingTimeError(400);
  signal.throwIfAborted();
  async function owned() {
    const result = await db
      .prepare(
        "SELECT address,revision FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address IN (SELECT value FROM json_each(?))",
      )
      .bind(owner, addresses)
      .all<{ address: string; revision: number }>();
    signal.throwIfAborted();
    if (
      result.results.length !== wallets.length ||
      wallets.some(
        (w) =>
          !result.results.some(
            (r) => r.address === w.address && r.revision === w.revision,
          ),
      )
    )
      throw new WalletFundingTimeError(409);
  }
  await owned();
  // Rank before validation: invalid latest evidence stays unknown, never silently
  // falls back to an older receipt. Only one <=4KiB document/receipt per wallet.
  const rows = await db
    .prepare(`SELECT * FROM (
    SELECT id,wallet_address AS wallet,wallet_revision AS walletRevision,state,signature,document,receipt,created_at AS createdAt,updated_at AS updatedAt,
    json_extract(document,'$.recipient') AS recipient,
    row_number() OVER(PARTITION BY json_extract(document,'$.recipient') ORDER BY updated_at DESC,id DESC) AS rank
    FROM native_withdrawals WHERE owner_id=? AND state='finalized' AND receipt IS NOT NULL
    AND COALESCE(json_type(document,'$.token'),'null')='null' AND json_extract(document,'$.recipient') IN (SELECT value FROM json_each(?))
  ) WHERE rank=1 LIMIT 100`)
    .bind(owner, addresses)
    .all<Row>();
  signal.throwIfAborted();
  const projected: WalletFundingTimes['wallets'] = [];
  for (const wallet of wallets) {
    const row = rows.results.find((r) => r.recipient === wallet.address);
    if (!row) {
      projected.push({
        ...wallet,
        funding: null,
        reason: 'no-retained-receipt',
      });
      continue;
    }
    try {
      const { document, receipt, ...rest } = row;
      const saved = await validatedNativeWithdrawal({
        ...rest,
        document: JSON.parse(document),
        receipt: receipt ? JSON.parse(receipt) : null,
      });
      signal.throwIfAborted();
      const r = saved.receipt;
      if (
        !r ||
        r.token ||
        saved.document.token ||
        r.recipient !== wallet.address ||
        BigInt(r.recipientChangeRaw) <= 0n ||
        !Number.isSafeInteger(r.blockTime) ||
        r.blockTime === null ||
        r.blockTime < 0 ||
        r.blockTime * 1000 > now
      )
        throw Error();
      projected.push({
        ...wallet,
        funding: {
          signature: r.signature,
          blockTime: r.blockTime,
          slot: r.slot,
        },
        reason: null,
      });
    } catch {
      signal.throwIfAborted();
      projected.push({
        ...wallet,
        funding: null,
        reason: 'unavailable-evidence',
      });
    }
  }
  await owned();
  return walletFundingTimes.parse({
    format: 'wallet-funding-times-v1',
    network: 'mainnet',
    scope: 'most-recently-saved-native-transfer',
    capturedAt: new Date(now).toISOString(),
    wallets: projected,
    executionAllowed: false,
  });
}
