import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { nativeWithdrawalFixture } from './native-withdrawal-fixture';
import {
  prepareNativeWithdrawal,
  decodeNativeWithdrawalReceipt,
} from '@/lib/native-withdrawal-server';
import { withdrawalInput, signNativeWithdrawal } from '@/lib/native-withdrawal';
/** Read-projection fixture only, not a financial writer or migration qualification. */
export async function walletFundingTimeFixture() {
  const source = await nativeWithdrawalFixture();
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,archived INTEGER,revision INTEGER);
  CREATE TABLE native_withdrawals(id TEXT,owner_id TEXT,wallet_address TEXT,wallet_revision INTEGER,state TEXT,signature TEXT,document TEXT,receipt TEXT,created_at TEXT,updated_at TEXT);`);
  const queries: string[] = [];
  const bindingCounts: number[] = [];
  let afterRead: (() => void) | undefined;
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      let values: SQLInputValue[] = [];
      return {
        bind(...args: SQLInputValue[]) {
          values = args;
          bindingCounts.push(args.length);
          return this;
        },
        async all() {
          const results = sqlite.prepare(sql).all(...values);
          afterRead?.();
          return { success: true, results };
        },
      };
    },
  } as unknown as D1Database;
  function wallet(address = source.recipient, owner = 'owner', revision = 1) {
    sqlite
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
      .run(owner, 'Solana', address, 0, revision);
    return { address, revision };
  }
  async function seed(
    address = source.recipient,
    blockTime: number | null = Math.floor(Date.now() / 1000) - 3600,
    owner = 'owner',
  ) {
    const review =
      address === source.recipient
        ? source.review
        : await prepareNativeWithdrawal(
            withdrawalInput(source.wallet, address, '0.01', 1),
            AbortSignal.timeout(10000),
            source.fetcher,
          );
    const signed =
      address === source.recipient
        ? source.signed
        : await signNativeWithdrawal(source.session, review, () => {});
    const receipt = await decodeNativeWithdrawalReceipt(
      {
        ...source.receipt,
        blockTime: blockTime === null ? null : String(blockTime),
        transaction: [signed.transaction, 'base64'],
      },
      review,
      signed.signature,
    );
    if ('failed' in receipt) throw Error('Expected synthetic success');
    const at = new Date().toISOString();
    sqlite
      .prepare('INSERT INTO native_withdrawals VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        review.id,
        owner,
        review.wallet,
        1,
        'finalized',
        signed.signature,
        JSON.stringify(review),
        JSON.stringify(receipt),
        at,
        at,
      );
    return { review, receipt };
  }
  return {
    source,
    sqlite,
    db,
    queries,
    bindingCounts,
    wallet,
    seed,
    afterRead(fn: () => void) {
      afterRead = fn;
    },
  };
}
