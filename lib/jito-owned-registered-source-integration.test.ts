import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
} from '@solana/kit';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { jitoSequentialEconomicsFixture } from '../test/jito-sequential-economics-fixture';
import { jitoDatabase } from '../test/jito-sqlite';
import { acquisitionReceipt } from '../test/imported-sell-acquisition-fixture';
import { tradeSessionTerms } from './imported-trade-session';
import { unsignedPreparationSummary } from './imported-swap-preparation-history';
import { bundleFingerprint } from './jito-bundle';
import { captureImportedAcquisition } from './imported-acquisition-server';
import {
  beginJitoSignAttempt,
  registerJitoSignAttempt,
} from './jito-sign-attempt-server';
import {
  captureOwnedRegisteredJitoSource,
  recheckOwnedRegisteredJitoSource,
} from './jito-owned-registered-source';

vi.mock('server-only', () => ({}));
const dbs: ReturnType<typeof jitoDatabase>[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.sqlite.close();
});
function signSynthetic(transaction: string) {
  const decoded = getTransactionDecoder().decode(
    Buffer.from(transaction, 'base64'),
  );
  const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  const signature = nacl.sign.detached(Uint8Array.from(decoded.messageBytes), pair.secretKey);
  const encoded = getTransactionEncoder().encode({
    messageBytes: decoded.messageBytes,
    signatures: { [bs58.encode(pair.publicKey)]: signature as SignatureBytes },
  });
  pair.secretKey.fill(0);
  return getBase64Decoder().decode(encoded);
}
async function setup() {
  const f = await jitoSequentialEconomicsFixture({ side: 'Sell' }),
    m = f.manifest,
    review = m.swaps[0],
    order = f.observations[0].order;
  const terms = tradeSessionTerms(
    {
      projectId: m.projectId,
      projectRevision: 1,
      side: 'Sell',
      entries: [{ wallet: review.wallet, walletRevision: 1, amount: '0.001' }],
    },
    { chain: 'Solana', address: order.inputMint, decimals: 6 },
  );
  const document = JSON.stringify(terms);
  review.session = {
    format: 'trade-session-entry-v1',
    sessionId: m.sessionId,
    sessionRevision: 1,
    entry: 1,
    unitsRaw: review.inputRaw,
    termsSha256: createHash('sha256').update(document).digest('hex'),
  };
  const d = jitoDatabase(m, true, true);
  dbs.push(d);
  d.sqlite.exec(`ALTER TABLE imported_token_projects ADD COLUMN document TEXT;
    ALTER TABLE imported_trade_sessions ADD COLUMN created_at TEXT; ALTER TABLE imported_trade_sessions ADD COLUMN updated_at TEXT;
    CREATE TABLE imported_trade_lot_links(id TEXT,owner_id TEXT,project_id TEXT,buy_receipt_id TEXT,sell_receipt_id TEXT,units_raw TEXT,buy_signature TEXT,sell_signature TEXT,buy_preparation_sha256 TEXT,sell_preparation_sha256 TEXT,created_at TEXT);
    CREATE TABLE imported_trade_lot_gates(owner_id TEXT,project_id TEXT,revision INTEGER);`);
  d.sqlite
    .prepare('UPDATE imported_token_projects SET address=?,document=?')
    .run(
      order.inputMint,
      JSON.stringify({
        token: { chain: 'Solana', address: order.inputMint, decimals: 6 },
      }),
    );
  d.sqlite
    .prepare(
      'UPDATE imported_trade_sessions SET document=?,created_at=?,updated_at=?',
    )
    .run(document, m.createdAt, m.createdAt);
  const receipt = acquisitionReceipt(2, 'Buy', '100000', review.wallet, 100);
  receipt.projectId = m.projectId;
  receipt.document.mint = order.inputMint;
  receipt.document.decimals = 6;
  d.sqlite
    .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(
      receipt.id,
      'owner',
      crypto.randomUUID(),
      receipt.preparationId,
      m.projectId,
      1,
      1,
      receipt.document.signature,
      JSON.stringify(receipt.document),
      receipt.createdAt,
    );
  const db = d.db,
    original = db.batch.bind(db);
  db.batch = (async (
    statements: { sql: string; all: () => Promise<{ results: unknown[] }> }[],
  ) => {
    if (statements.every((s) => /^SELECT\b/i.test(s.sql)))
      return Promise.all(
        statements.map(async (s) => ({ ...(await s.all()), success: true })),
      );
    return original(statements as never);
  }) as unknown as typeof db.batch;
  const acquisition = await captureImportedAcquisition(
    db,
    'owner',
    m.projectId,
    review.wallet,
    order.inputMint,
    6,
    receipt.id,
    review.inputRaw,
  );
  review.acquisition = acquisition.selection;
  m.sha256 = await bundleFingerprint((({ sha256: _hash, ...rest }) => rest)(m));
  const summary = unsignedPreparationSummary(
    order,
    f.observations[0].simulation,
  );
  d.sqlite
    .prepare('UPDATE imported_swap_preparations SET document=? WHERE id=?')
    .run(
      JSON.stringify({
        ...summary,
        session: review.session,
        acquisition: review.acquisition,
      }),
      review.preparationId,
    );
  d.sqlite
    .prepare('DELETE FROM imported_swap_signing_intents WHERE id=?')
    .run(review.id);
  d.sqlite
    .prepare(
      'INSERT INTO imported_swap_signing_intents VALUES(?,?,?,?,?,?,NULL,?,?)',
    )
    .run(
      review.id,
      'owner',
      review.preparationId,
      review.wallet,
      JSON.stringify(review),
      'awaiting_signature',
      m.createdAt,
      m.createdAt,
    );
  d.attach();
  for (const [packet, transaction] of [
    review.transaction,
    m.tip.transaction,
  ].entries()) {
    const nonce = crypto.randomUUID();
    await beginJitoSignAttempt(db, 'owner', m.id, m.sha256, packet, nonce);
    await registerJitoSignAttempt(
      db,
      'owner',
      m.id,
      m.sha256,
      packet,
      nonce,
      signSynthetic(transaction),
    );
  }
  return { d, db, m, receipt };
}
it('checks actual preparation, session and acquisition readers against a synthetic registered sell', async () => {
  const f = await setup(),
    fetcher = vi.spyOn(globalThis, 'fetch');
  try {
    const handle = await captureOwnedRegisteredJitoSource(
      f.db,
      'owner',
      f.m.id,
      f.m.sha256,
    );
    expect((await recheckOwnedRegisteredJitoSource(handle)).matched).toBe(true);
    f.d.sqlite
      .prepare('DELETE FROM imported_swap_receipts WHERE id=?')
      .run(f.receipt.id);
    await expect(recheckOwnedRegisteredJitoSource(handle)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});
it.each(['session', 'wallet', 'project'] as const)(
  'rejects a changed real %s after capture',
  async (part) => {
    const f = await setup();
    const h = await captureOwnedRegisteredJitoSource(
      f.db,
      'owner',
      f.m.id,
      f.m.sha256,
    );
    if (part === 'session')
      f.d.sqlite
        .prepare(
          "UPDATE imported_trade_session_controls SET state='paused',revision=revision+1 WHERE owner_id=? AND session_id=?",
        )
        .run('owner', f.m.sessionId);
    if (part === 'wallet')
      f.d.sqlite
        .prepare(
          'UPDATE workspace_wallets SET revision=revision+1 WHERE owner_id=? AND address=?',
        )
        .run('owner', f.m.swaps[0].wallet);
    if (part === 'project')
      f.d.sqlite
        .prepare(
          'UPDATE imported_token_projects SET revision=revision+1 WHERE owner_id=? AND id=?',
        )
        .run('owner', f.m.projectId);
    await expect(recheckOwnedRegisteredJitoSource(h)).rejects.toThrow();
  },
);
