import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  receiptKeyPair,
  receiptWallet,
  receiptSignature,
  receiptClaim,
  receiptRecipient,
  receiptMint,
  tokenReceiptFixture,
  memoReceiptFixture,
  failedMemoReceiptFixture,
  failedTokenReceiptFixture,
  nativeFundingInput,
  nativeFundingDocument,
  nativeReceiptFixture,
} from '../../../test/devnet-receipt-fixture';
import { distributionAuditKey } from '@/lib/distribution-audit';
import { savedFundingIntent } from '@/lib/devnet-saved-funding';
import { validateFunding } from '@/lib/funding-plan';
import { GET as nativeStatus } from '../funding/devnet/route';
import { GET as fundingExecutionHistory } from '../funding/history/route';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string; email: string } | null,
  db: null as unknown as D1Database,
  transaction: vi.fn(),
  slot: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({
  ensurePulseSchema: async () => mocks.db,
  getD1: () => mocks.db,
}));
vi.mock('@/lib/solana-transfer-receipt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/solana-transfer-receipt')>()),
  readFinalizedDevnetTransaction: mocks.transaction,
  readDevnetOperationSlot: mocks.slot,
}));
import { POST as challenge } from './challenge/route';
import { POST as verify } from './verify/route';
import { GET as history, POST as receipt } from './events/route';
import {
  ReceiptError,
  verifyNativeFundingReceipt,
} from '@/lib/solana-transfer-receipt';
import { operationDocument } from '@/lib/wallet-operation';
import {
  GET as pendingOperations,
  POST as operation,
} from './operations/route';
let mf: Miniflare;
const request = (path: string, body?: unknown, origin = 'http://localhost') =>
  new Request(
    `${origin}/api/wallet/${path}`,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
const sign = (message: string) =>
  bs58.encode(
    nacl.sign.detached(
      new TextEncoder().encode(message),
      receiptKeyPair.secretKey,
    ),
  );
async function prove() {
  const result = await challenge(
    request('challenge', { address: receiptWallet }),
  );
  expect(result.status).toBe(200);
  const data = (await result.json()) as { id: string; message: string };
  const body = {
    id: data.id,
    address: receiptWallet,
    signature: sign(data.message),
  };
  expect((await verify(request('verify', body))).status).toBe(200);
  return body;
}
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'wallet-audit-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default {fetch(){return new Response("test")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'wallet-audit-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'wallet-audit-test',
  )) as unknown as D1Database;
  for (const file of [
    '0004_sudden_wendigo.sql',
    '0007_superb_iron_monger.sql',
    '0022_owned_devnet_audit.sql',
    '0023_wallet_operations.sql',
  ])
    for (const sql of readFileSync(
      new URL('../../../drizzle/' + file, import.meta.url),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((sql) => sql.trim()))
      await mocks.db.prepare(sql).run();
});
afterAll(async () => {
  await mf.dispose();
});
beforeEach(async () => {
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  mocks.transaction.mockReset();
  mocks.slot.mockReset().mockResolvedValue(12344);
  for (const table of [
    'wallet_operations',
    'wallet_audit_events',
    'wallet_challenges',
    'wallet_receipt_gates',
    'funding_plans',
  ])
    await mocks.db.prepare(`DELETE FROM ${table}`).run();
});

describe('durable wallet operation reservations', () => {
  const executionHistory = (revision = 1, cursor = '') =>
    fundingExecutionHistory(
      new Request(
        `http://localhost/api/funding/history?id=funding-test&revision=${revision}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    );
  const native = () => ({
    id: crypto.randomUUID(),
    claim: crypto.randomUUID(),
    document: nativeFundingInput,
  });
  const saveNative = async (patch = {}) => {
    await mocks.db
      .prepare(
        'INSERT INTO funding_plans(owner_id,id,document,revision,archived,mutation_id,updated_at) VALUES (?,?,?,?,0,?,?)',
      )
      .bind(
        'alice',
        'funding-test',
        JSON.stringify(validateFunding({ ...nativeFundingDocument, ...patch })),
        1,
        crypto.randomUUID(),
        new Date().toISOString(),
      )
      .run();
  };
  it('retains verified funding history after revision, funder and archive changes with owner isolation', async () => {
    await prove();
    await saveNative();
    const data = native();
    await mutate({ ...data, action: 'reserve' });
    await mutate({ ...data, action: 'arm' });
    mocks.transaction.mockResolvedValue(nativeReceiptFixture());
    expect(
      (
        await receipt(
          request('events', {
            address: receiptWallet,
            signature: receiptSignature,
            operationId: data.id,
            nativeFunding: true,
          }),
        )
      ).status,
    ).toBe(200);
    await mocks.db
      .prepare('UPDATE funding_plans SET revision=2,archived=1,document=?')
      .bind(
        JSON.stringify(
          validateFunding({
            ...nativeFundingDocument,
            name: 'Changed archived draft',
            funderAddress: receiptRecipient,
            recipients: [{ address: receiptWallet, amount: '0.7' }],
          }),
        ),
      )
      .run();
    expect((await executionHistory()).status).toBe(409);
    const response = await executionHistory(2);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      revision: 2,
      archived: true,
      pending: [],
      receipts: [
        {
          wallet: receiptWallet,
          recipient: receiptRecipient,
          amount: '0.300000001',
          fundingRevision: 1,
          outcome: 'finalized',
          feeLamports: '5000',
        },
      ],
    });
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await executionHistory(2)).status).toBe(404);
    mocks.user = null;
    expect((await executionHistory(2)).status).toBe(401);
  });
  it('shows unknown approval outcomes on archived funding drafts and excludes expired preparations', async () => {
    await prove();
    await saveNative();
    const data = native();
    await mutate({ ...data, action: 'reserve' });
    expect(await (await executionHistory()).json()).toMatchObject({
      receipts: [],
      pending: [{ state: 'preparing', signature: null }],
    });
    await mocks.db
      .prepare('UPDATE wallet_operations SET expires_at=?')
      .bind('2020-01-01T00:00:00.000Z')
      .run();
    expect(await (await executionHistory()).json()).toMatchObject({
      pending: [],
    });
    const next = native();
    await mutate({ ...next, action: 'reserve' });
    await mutate({ ...next, action: 'arm' });
    await mocks.db
      .prepare('UPDATE funding_plans SET archived=1,revision=2')
      .run();
    expect(await (await executionHistory(2)).json()).toMatchObject({
      archived: true,
      receipts: [],
      pending: [
        {
          id: next.id,
          wallet: receiptWallet,
          amount: '0.300000001',
          state: 'awaiting_signature',
          signature: null,
          fundingRevision: 1,
        },
      ],
    });
  });
  it('paginates same-time verified funding receipts without crossing funding or account scopes', async () => {
    await saveNative();
    const intent = await operationDocument(nativeFundingInput);
    if (intent.kind !== 'sol') throw new Error();
    const event = {
      details: JSON.stringify(
        verifyNativeFundingReceipt(
          nativeReceiptFixture(),
          receiptSignature,
          intent,
        ),
      ),
      created_at: new Date().toISOString(),
    };
    await mocks.db.batch(
      Array.from({ length: 51 }, (_, index) =>
        mocks.db
          .prepare(`INSERT INTO wallet_audit_events
      (id,owner_id,wallet_address,network,event_type,transaction_signature,details,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(
            crypto.randomUUID(),
            'alice',
            receiptWallet,
            'devnet',
            'native_transfer_finalized',
            bs58.encode(new Uint8Array(64).fill(index + 20)),
            event!.details,
            event!.created_at,
          ),
      ),
    );
    const first = (await (await executionHistory()).json()) as {
      receipts: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(first.receipts).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = (await (
      await executionHistory(1, first.nextCursor)
    ).json()) as { receipts: Array<{ id: string }>; nextCursor: null };
    expect(second.receipts).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.receipts, ...second.receipts].map((row) => row.id))
        .size,
    ).toBe(51);
    expect((await executionHistory(1, 'bad~cursor')).status).toBe(400);
    await mocks.db
      .prepare(
        `UPDATE wallet_audit_events SET details=json_set(details,'$.rawAmount','1') WHERE event_type='native_transfer_finalized'`,
      )
      .run();
    expect((await executionHistory()).status).toBe(503);
  });
  const saveToken = () =>
    saveNative({
      currency: 'USDC',
      assetAddress: receiptMint,
      recipients: [{ address: receiptRecipient, amount: '0.300001' }],
    });
  const token = async (revision = 1) => ({
    id: crypto.randomUUID(),
    claim: crypto.randomUUID(),
    document: await savedFundingIntent(
      {
        ...nativeFundingDocument,
        currency: 'USDC',
        assetAddress: receiptMint,
        recipients: [{ address: receiptRecipient, amount: '0.300001' }],
      },
      'funding-test',
      revision,
      receiptRecipient,
    ),
  });
  const tokenTx = async () => {
    const tx = await tokenReceiptFixture();
    for (const row of [
      ...tx.meta.preTokenBalances,
      ...tx.meta.postTokenBalances,
    ])
      row.uiTokenAmount.decimals = 6;
    tx.meta.postTokenBalances[0].uiTokenAmount.amount = '999699999';
    tx.meta.postTokenBalances[1].uiTokenAmount.amount = '300001';
    tx.transaction.message.instructions[0].parsed.info.tokenAmount = {
      amount: '300001',
      decimals: 6,
    };
    return tx;
  };
  it('binds saved SPL reservations to the exact funder, mint, amount and active revision', async () => {
    await prove();
    await saveToken();
    const data = await token();
    const doc = data.document;
    if (doc.kind !== 'spl') throw new Error();
    for (const distribution of [
      {
        ...doc.distribution,
        mint: 'So11111111111111111111111111111111111111112',
      },
      {
        ...doc.distribution,
        recipients: [{ address: receiptRecipient, amount: '0.3' }],
      },
    ])
      expect(
        (
          await mutate({
            ...data,
            document: { ...doc, distribution },
            action: 'reserve',
          })
        ).status,
      ).toBe(409);
    expect((await mutate({ ...data, action: 'reserve' })).status).toBe(200);
    await mocks.db.prepare('UPDATE funding_plans SET revision=2').run();
    expect((await mutate({ ...data, action: 'arm' })).status).toBe(409);
    const response = await nativeStatus(
      new Request(
        'http://localhost/api/funding/devnet?id=funding-test&revision=2',
      ),
    );
    expect(await response.json()).toMatchObject({
      asset: { mint: receiptMint, decimals: 6 },
      completed: [],
    });
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect(
      (
        await nativeStatus(
          new Request(
            'http://localhost/api/funding/devnet?id=funding-test&revision=2',
          ),
        )
      ).status,
    ).toBe(404);
  });
  it('verifies retained saved SPL receipts after draft edits and prevents repeated payment across revisions', async () => {
    await prove();
    await saveToken();
    const data = await token();
    expect((await mutate({ ...data, action: 'reserve' })).status).toBe(200);
    expect((await mutate({ ...data, action: 'arm' })).status).toBe(200);
    await mocks.db.prepare('UPDATE funding_plans SET revision=2').run();
    mocks.transaction.mockResolvedValue(await tokenTx());
    const body = {
      address: receiptWallet,
      signature: receiptSignature,
      operationId: data.id,
      savedFunding: true,
    };
    const result = await receipt(request('events', body));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      recorded: true,
      outcome: 'finalized',
    });
    expect((await receipt(request('events', body))).status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const status = await nativeStatus(
      new Request(
        'http://localhost/api/funding/devnet?id=funding-test&revision=2',
      ),
    );
    expect(await status.json()).toMatchObject({
      completed: [expect.any(String)],
    });
    expect(
      (await mutate({ ...(await token(2)), action: 'reserve' })).status,
    ).toBe(403);
  });
  it('resolves failed saved SPL transfers without paid counts and rejects unbound receipt claims', async () => {
    await prove();
    await saveToken();
    const data = await token();
    await mutate({ ...data, action: 'reserve' });
    await mutate({ ...data, action: 'arm' });
    if (data.document.kind !== 'spl') throw new Error();
    expect(
      (
        await receipt(
          request('events', {
            address: receiptWallet,
            signature: receiptSignature,
            operationId: data.id,
            distribution: data.document.distribution,
            recipient: receiptRecipient,
          }),
        )
      ).status,
    ).toBe(409);
    const tx = await tokenTx();
    mocks.transaction.mockResolvedValue({
      ...tx,
      meta: {
        ...tx.meta,
        err: { InstructionError: [0, { Custom: 1 }] },
        fee: 5000,
        preBalances: [1000000, 2039280, 2039280],
        postBalances: [995000, 2039280, 2039280],
        postTokenBalances: structuredClone(tx.meta.preTokenBalances),
      },
    });
    const result = await receipt(
      request('events', {
        address: receiptWallet,
        signature: receiptSignature,
        operationId: data.id,
        savedFunding: true,
      }),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ outcome: 'failed' });
    const status = await nativeStatus(
      new Request(
        'http://localhost/api/funding/devnet?id=funding-test&revision=1',
      ),
    );
    expect(await status.json()).toMatchObject({ completed: [] });
    expect(
      (await mutate({ ...(await token()), action: 'reserve' })).status,
    ).toBe(200);
  });
  it('requires an exact active owned saved native funding draft and isolates status reads', async () => {
    await prove();
    const data = native();
    expect((await mutate({ ...data, action: 'reserve' })).status).toBe(409);
    await saveNative();
    for (const patch of [
      { amount: '0.3' },
      { fundingRevision: 2 },
      { wallet: receiptRecipient, recipient: receiptWallet },
    ])
      expect(
        (
          await mutate({
            ...data,
            document: { ...data.document, ...patch },
            action: 'reserve',
          })
        ).status,
      ).toBe(409);
    expect((await mutate({ ...data, action: 'reserve' })).status).toBe(200);
    const req = new Request(
      'http://localhost/api/funding/devnet?id=funding-test&revision=1',
    );
    expect((await nativeStatus(req)).status).toBe(200);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await nativeStatus(req)).status).toBe(404);
    mocks.user = null;
    expect((await nativeStatus(req)).status).toBe(401);
  });
  it('holds native funding approval if its saved draft changes after reservation', async () => {
    await prove();
    await saveNative();
    const data = native();
    await mutate({ ...data, action: 'reserve' });
    await mocks.db.prepare('UPDATE funding_plans SET revision=2').run();
    expect((await mutate({ ...data, action: 'arm' })).status).toBe(409);
    expect(
      (
        await nativeStatus(
          new Request(
            'http://localhost/api/funding/devnet?id=funding-test&revision=1',
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      await mocks.db
        .prepare('SELECT state FROM wallet_operations WHERE id=?')
        .bind(data.id)
        .first(),
    ).toMatchObject({ state: 'preparing' });
  });
  it('verifies native funding receipts, preserves completed recipients across revisions and refuses stale repeats', async () => {
    await prove();
    await saveNative();
    const data = native();
    await mutate({ ...data, action: 'reserve' });
    await mutate({ ...data, action: 'arm' });
    mocks.transaction.mockResolvedValue(nativeReceiptFixture());
    const body = {
      address: receiptWallet,
      signature: receiptSignature,
      operationId: data.id,
      nativeFunding: true,
    };
    const result = await receipt(request('events', body));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      outcome: 'finalized',
      recorded: true,
    });
    expect((await receipt(request('events', body))).status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const status = await nativeStatus(
      new Request(
        'http://localhost/api/funding/devnet?id=funding-test&revision=1',
      ),
    );
    expect(await status.json()).toMatchObject({
      completed: [expect.any(String)],
      network: 'devnet',
    });
    await mocks.db.prepare('UPDATE funding_plans SET revision=2').run();
    expect(
      (
        await mutate({
          ...native(),
          document: { ...nativeFundingInput, fundingRevision: 2 },
          action: 'reserve',
        })
      ).status,
    ).toBe(403);
    const historyResponse = await history(
      request('events?address=' + receiptWallet + '&fundingId=funding-test'),
    );
    expect(await historyResponse.json()).toMatchObject({
      events: [{ eventType: 'native_transfer_finalized' }],
    });
  }, 15000);
  it('resolves finalized native failures without marking recipients paid and retains mismatched receipts', async () => {
    await prove();
    await saveNative();
    const data = native();
    await mutate({ ...data, action: 'reserve' });
    await mutate({ ...data, action: 'arm' });
    const tx = nativeReceiptFixture();
    tx.meta.postBalances[1] = '1';
    mocks.transaction.mockResolvedValue(tx);
    const body = {
      address: receiptWallet,
      signature: receiptSignature,
      operationId: data.id,
      nativeFunding: true,
    };
    expect((await receipt(request('events', body))).status).toBe(400);
    await mocks.db.prepare('DELETE FROM wallet_receipt_gates').run();
    mocks.transaction.mockResolvedValue(nativeReceiptFixture(true));
    const result = await receipt(request('events', body));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ outcome: 'failed' });
    expect(
      await mocks.db
        .prepare('SELECT state FROM wallet_operations WHERE id=?')
        .bind(data.id)
        .first(),
    ).toMatchObject({ state: 'failed' });
    const status = await nativeStatus(
      new Request(
        'http://localhost/api/funding/devnet?id=funding-test&revision=1',
      ),
    );
    expect(await status.json()).toMatchObject({ completed: [] });
    expect((await mutate({ ...native(), action: 'reserve' })).status).toBe(200);
  });
  const intent = () => ({
    id: crypto.randomUUID(),
    claim: crypto.randomUUID(),
    document: { kind: 'memo', wallet: receiptWallet },
  });
  const mutate = (data: unknown) => operation(request('operations', data));
  const reserve = (data: ReturnType<typeof intent>) =>
    mutate({ ...data, action: 'reserve' });
  it('releases session-owned unsigned rejected approvals and admits a fresh reservation', async () => {
    await prove();
    const data = intent();
    await reserve(data);
    expect((await mutate({ ...data, action: 'rejected' })).status).toBe(409);
    await mutate({ ...data, action: 'arm' });
    expect(
      (
        await mutate({
          ...data,
          claim: crypto.randomUUID(),
          action: 'rejected',
        })
      ).status,
    ).toBe(403);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await mutate({ ...data, action: 'rejected' })).status).toBe(404);
    mocks.user = { userId: 'alice', email: 'alice@example.test' };
    const released = await mutate({ ...data, action: 'rejected' });
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({
      operation: { state: 'cancelled', signature: null },
    });
    expect((await mutate({ ...data, action: 'rejected' })).status).toBe(200);
    expect(
      (
        await mutate({
          ...data,
          action: 'submitted',
          signature: receiptSignature,
        })
      ).status,
    ).toBe(409);
    expect((await reserve(intent())).status).toBe(200);
  });
  it('does not release registered signatures and serializes rejection against registration', async () => {
    await prove();
    const data = intent();
    await reserve(data);
    await mutate({ ...data, action: 'arm' });
    const results = await Promise.all([
      mutate({ ...data, action: 'submitted', signature: receiptSignature }),
      mutate({ ...data, action: 'rejected' }),
    ]);
    expect(
      results.map((result) => result.status).sort((a, b) => a - b),
    ).toEqual([200, 409]);
    const saved = await mocks.db
      .prepare('SELECT state,signature FROM wallet_operations WHERE id=?')
      .bind(data.id)
      .first<{ state: string; signature: string | null }>();
    if (saved?.state === 'submitted') {
      expect(saved.signature).toBe(receiptSignature);
      expect((await mutate({ ...data, action: 'rejected' })).status).toBe(409);
      expect((await reserve(intent())).status).toBe(409);
    } else {
      expect(saved).toMatchObject({ state: 'cancelled', signature: null });
      expect(
        (
          await mutate({
            ...data,
            action: 'submitted',
            signature: receiptSignature,
          })
        ).status,
      ).toBe(409);
    }
  });
  it('always retains a previously registered signature after a rejection report', async () => {
    await prove();
    const data = intent();
    await reserve(data);
    await mutate({ ...data, action: 'arm' });
    expect(
      (
        await mutate({
          ...data,
          action: 'submitted',
          signature: receiptSignature,
        })
      ).status,
    ).toBe(200);
    expect((await mutate({ ...data, action: 'rejected' })).status).toBe(409);
    expect((await reserve(intent())).status).toBe(409);
    expect(
      await mocks.db
        .prepare('SELECT state,signature FROM wallet_operations WHERE id=?')
        .bind(data.id)
        .first(),
    ).toMatchObject({ state: 'submitted', signature: receiptSignature });
  });
  it('requires authentication and recent wallet proof and hides approval credentials', async () => {
    const data = intent();
    mocks.user = null;
    expect((await reserve(data)).status).toBe(401);
    expect(
      (await pendingOperations(request('operations?address=' + receiptWallet)))
        .status,
    ).toBe(401);
    mocks.user = { userId: 'alice', email: 'alice@example.test' };
    expect((await reserve(data)).status).toBe(403);
    await prove();
    expect((await reserve(data)).status).toBe(200);
    const response = await pendingOperations(
      request('operations?address=' + receiptWallet),
    );
    const text = await response.text();
    expect(text).not.toContain(data.claim);
    expect(text).not.toContain('claim_hash');
    expect(text).toContain(data.id);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await mutate({ ...data, action: 'arm' })).status).toBe(404);
    expect(
      (
        (await (
          await pendingOperations(
            request('operations?address=' + receiptWallet),
          )
        ).json()) as { active: unknown }
      ).active,
    ).toBeNull();
  });
  it('admits one competing reservation, supports reserve retries and prevents approval reuse', async () => {
    await prove();
    const data = intent(),
      other = intent();
    const responses = await Promise.all([reserve(data), reserve(other)]);
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const winner = responses[0].status === 200 ? data : other;
    expect((await reserve(winner)).status).toBe(200);
    expect(
      (await mutate({ ...winner, claim: crypto.randomUUID(), action: 'arm' }))
        .status,
    ).toBe(403);
    expect((await mutate({ ...winner, action: 'arm' })).status).toBe(200);
    expect((await mutate({ ...winner, action: 'arm' })).status).toBe(409);
    expect((await mutate({ ...winner, action: 'cancel' })).status).toBe(409);
    expect((await reserve(intent())).status).toBe(409);
  });
  it('expires unstarted leases but keeps armed operations unresolved without an arbitrary deadline', async () => {
    await prove();
    const data = intent();
    expect((await reserve(data)).status).toBe(200);
    mocks.slot.mockRejectedValueOnce(new Error('RPC unavailable'));
    expect((await mutate({ ...data, action: 'arm' })).status).toBe(502);
    expect(
      (await mocks.db
        .prepare('SELECT state FROM wallet_operations WHERE id=?')
        .bind(data.id)
        .first<{ state: string }>())!.state,
    ).toBe('preparing');
    await mocks.db
      .prepare(
        "UPDATE wallet_operations SET expires_at='2020-01-01T00:00:00.000Z'",
      )
      .run();
    expect((await mutate({ ...data, action: 'arm' })).status).toBe(409);
    const next = intent();
    expect((await reserve(next)).status).toBe(200);
    expect((await mutate({ ...next, action: 'arm' })).status).toBe(200);
    await mocks.db
      .prepare(
        "UPDATE wallet_operations SET expires_at='2020-01-01T00:00:00.000Z'",
      )
      .run();
    expect((await reserve(intent())).status).toBe(409);
    expect(
      (
        (await (
          await pendingOperations(
            request('operations?address=' + receiptWallet),
          )
        ).json()) as { active: { id: string } }
      ).active.id,
    ).toBe(next.id);
  });
  it('recovers a signature from another browser by verifying its matching finalized receipt', async () => {
    await prove();
    const data = intent();
    await reserve(data);
    await mutate({ ...data, action: 'arm' });
    const older = memoReceiptFixture(),
      olderSignature = bs58.encode(new Uint8Array(64).fill(12));
    older.transaction.signatures[0] = olderSignature;
    older.slot = 12344;
    mocks.transaction.mockResolvedValueOnce(older);
    expect(
      (
        await receipt(
          request('events', {
            address: receiptWallet,
            signature: olderSignature,
            operationId: data.id,
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        (await (
          await pendingOperations(
            request('operations?address=' + receiptWallet),
          )
        ).json()) as { active: { id: string } }
      ).active.id,
    ).toBe(data.id);
    await mocks.db.prepare('DELETE FROM wallet_receipt_gates').run();
    const tx = memoReceiptFixture();
    tx.blockTime = Math.floor(Date.now() / 1000);
    mocks.transaction.mockResolvedValue(tx);
    const body = {
      address: receiptWallet,
      signature: receiptSignature,
      operationId: data.id,
    };
    expect((await receipt(request('events', body))).status).toBe(200);
    expect((await receipt(request('events', body))).status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(
      (
        (await (
          await pendingOperations(
            request('operations?address=' + receiptWallet),
          )
        ).json()) as { active: unknown }
      ).active,
    ).toBeNull();
    const row = await mocks.db
      .prepare('SELECT state,signature FROM wallet_operations WHERE id=?')
      .bind(data.id)
      .first();
    expect(row).toMatchObject({
      state: 'finalized',
      signature: receiptSignature,
    });
    expect((await reserve(intent())).status).toBe(200);
  });
  it('retains a pending token operation after a wrong or older receipt and rejects stale-tab repeats once finalized', async () => {
    await prove();
    const data = {
      ...intent(),
      document: {
        kind: 'spl',
        wallet: receiptWallet,
        distribution: receiptClaim,
        recipient: receiptRecipient,
      },
    };
    expect((await mutate({ ...data, action: 'reserve' })).status).toBe(200);
    expect((await mutate({ ...data, action: 'arm' })).status).toBe(200);
    const tx = await tokenReceiptFixture();
    tx.blockTime = Math.floor(Date.now() / 1000);
    mocks.transaction.mockResolvedValue(tx);
    const body = {
      address: receiptWallet,
      signature: receiptSignature,
      distribution: receiptClaim,
      recipient: receiptRecipient,
      operationId: data.id,
    };
    expect((await receipt(request('events', body))).status).toBe(200);
    expect(
      (
        await mutate({
          ...data,
          id: crypto.randomUUID(),
          claim: crypto.randomUUID(),
          action: 'reserve',
        })
      ).status,
    ).toBe(403);
    const memo = intent();
    expect((await reserve(memo)).status).toBe(200);
    expect((await mutate({ ...memo, action: 'arm' })).status).toBe(200);
    expect(
      (await receipt(request('events', { ...body, operationId: memo.id })))
        .status,
    ).toBe(409);
    expect(
      (
        (await (
          await pendingOperations(
            request('operations?address=' + receiptWallet),
          )
        ).json()) as { active: { id: string } }
      ).active.id,
    ).toBe(memo.id);
  });
  it('registers a known signature idempotently and rejects replacement or incomplete failure evidence', async () => {
    await prove();
    const data = intent();
    await reserve(data);
    await mutate({ ...data, action: 'arm' });
    const body = { ...data, action: 'submitted', signature: receiptSignature };
    expect((await mutate(body)).status).toBe(200);
    expect((await mutate(body)).status).toBe(200);
    expect(
      (
        await mutate({
          ...body,
          signature: bs58.encode(new Uint8Array(64).fill(10)),
        })
      ).status,
    ).toBe(409);
    const tx = memoReceiptFixture();
    (tx.meta as { err: unknown }).err = { InstructionError: [0, 'failed'] };
    mocks.transaction.mockResolvedValue(tx);
    expect(
      (
        await receipt(
          request('events', {
            address: receiptWallet,
            signature: receiptSignature,
            operationId: data.id,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        (await (
          await pendingOperations(
            request('operations?address=' + receiptWallet),
          )
        ).json()) as { active: { state: string } }
      ).active.state,
    ).toBe('submitted');
  });
  it('resolves a finalized memo failure idempotently and permits a fresh reviewed operation', async () => {
    await prove();
    const data = intent();
    await reserve(data);
    await mutate({ ...data, action: 'arm' });
    await mutate({ ...data, action: 'submitted', signature: receiptSignature });
    mocks.transaction.mockResolvedValue(failedMemoReceiptFixture());
    const body = {
      address: receiptWallet,
      signature: receiptSignature,
      operationId: data.id,
    };
    const response = await receipt(request('events', body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recorded: true,
      outcome: 'failed',
      event: { eventType: 'memo_failed' },
    });
    expect((await receipt(request('events', body))).status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(
      await mocks.db
        .prepare('SELECT state,signature FROM wallet_operations WHERE id=?')
        .bind(data.id)
        .first(),
    ).toEqual({ state: 'failed', signature: receiptSignature });
    const next = intent();
    expect((await reserve(next)).status).toBe(200);
    expect((await mutate({ ...next, action: 'arm' })).status).toBe(200);
    expect(
      (await receipt(request('events', { ...body, operationId: next.id })))
        .status,
    ).toBe(409);
    expect(
      (
        (await (
          await pendingOperations(
            request('operations?address=' + receiptWallet),
          )
        ).json()) as { active: { id: string } }
      ).active.id,
    ).toBe(next.id);
  });
  it('records failed SPL history without completing the recipient and retains unrelated or stale reservations', async () => {
    await prove();
    const data = {
      ...intent(),
      document: {
        kind: 'spl',
        wallet: receiptWallet,
        distribution: receiptClaim,
        recipient: receiptRecipient,
      },
    };
    expect((await mutate({ ...data, action: 'reserve' })).status).toBe(200);
    expect((await mutate({ ...data, action: 'arm' })).status).toBe(200);
    const body = {
      address: receiptWallet,
      signature: receiptSignature,
      distribution: receiptClaim,
      recipient: receiptRecipient,
      operationId: data.id,
    };
    const tx = await failedTokenReceiptFixture();
    const oldSignature = bs58.encode(new Uint8Array(64).fill(12));
    tx.slot = 12344;
    tx.transaction.signatures[0] = oldSignature;
    mocks.transaction.mockResolvedValue(tx);
    expect(
      (await receipt(request('events', { ...body, signature: oldSignature })))
        .status,
    ).toBe(409);
    expect(
      (
        (await (
          await pendingOperations(
            request('operations?address=' + receiptWallet),
          )
        ).json()) as { active: { id: string } }
      ).active.id,
    ).toBe(data.id);
    await mocks.db.exec('DELETE FROM wallet_receipt_gates');
    tx.slot = 12345;
    tx.transaction.signatures[0] = receiptSignature;
    const result = await receipt(request('events', body));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      outcome: 'failed',
      event: { eventType: 'token_transfer_failed' },
    });
    expect(
      (await mocks.db
        .prepare(
          "SELECT COUNT(*) AS n FROM wallet_audit_events WHERE event_type='token_transfer_finalized'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(0);
    const next = {
      ...data,
      id: crypto.randomUUID(),
      claim: crypto.randomUUID(),
    };
    expect((await mutate({ ...next, action: 'reserve' })).status).toBe(200);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await receipt(request('events', body))).status).toBe(403);
  });
});
describe('owned durable wallet audit', () => {
  it('requires authentication for every wallet audit endpoint', async () => {
    mocks.user = null;
    for (const result of await Promise.all([
      challenge(request('challenge', {})),
      verify(request('verify', {})),
      receipt(request('events', {})),
      history(request('events')),
    ]))
      expect(result.status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('binds real ed25519 proofs to account and origin, then rejects replay', async () => {
    const result = await challenge(
        request('challenge', { address: receiptWallet }),
      ),
      data = (await result.json()) as { id: string; message: string };
    expect(data.message).toContain('Origin: http://localhost\nAccount: alice');
    const body = {
      id: data.id,
      address: receiptWallet,
      signature: sign(data.message),
    };
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await verify(request('verify', body))).status).toBe(404);
    mocks.user = { userId: 'alice', email: 'alice@example.test' };
    expect(
      (await verify(request('verify', body, 'https://other.test'))).status,
    ).toBe(404);
    expect(
      (
        await verify(
          request('verify', {
            ...body,
            signature: sign(data.message + 'tamper'),
          }),
        )
      ).status,
    ).toBe(401);
    expect((await verify(request('verify', body))).status).toBe(200);
    expect((await verify(request('verify', body))).status).toBe(409);
    const events = (await (await history(request('events'))).json()) as {
      events: unknown[];
    };
    expect(events.events).toHaveLength(1);
  });
  it('atomically admits at most five concurrent active challenges for an account and wallet', async () => {
    const results = await Promise.all(
      Array.from({ length: 9 }, () =>
        challenge(request('challenge', { address: receiptWallet })),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(4);
  });
  it('records only one ownership event when verification requests race', async () => {
    const data = (await (
      await challenge(request('challenge', { address: receiptWallet }))
    ).json()) as { id: string; message: string };
    const body = {
      id: data.id,
      address: receiptWallet,
      signature: sign(data.message),
    };
    const results = await Promise.all([
      verify(request('verify', body)),
      verify(request('verify', body)),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    expect(
      (await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM wallet_audit_events')
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });
  it('rolls back challenge consumption if audit storage fails and redacts storage errors', async () => {
    const data = (await (
      await challenge(request('challenge', { address: receiptWallet }))
    ).json()) as { id: string; message: string };
    await mocks.db
      .prepare(
        "CREATE TRIGGER reject_wallet_audit BEFORE INSERT ON wallet_audit_events BEGIN SELECT RAISE(ABORT,'private database error'); END",
      )
      .run();
    try {
      const response = await verify(
        request('verify', {
          id: data.id,
          address: receiptWallet,
          signature: sign(data.message),
        }),
      );
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private database');
      expect(
        (await mocks.db
          .prepare('SELECT used_at FROM wallet_challenges WHERE id=?')
          .bind(data.id)
          .first<{ used_at: string | null }>())!.used_at,
      ).toBeNull();
    } finally {
      await mocks.db.prepare('DROP TRIGGER reject_wallet_audit').run();
    }
  });
  it('keeps legacy unowned records hidden and paginates equal-time owner events without overlap', async () => {
    const time = new Date().toISOString();
    await mocks.db.batch(
      Array.from({ length: 58 }, (_, i) =>
        mocks.db
          .prepare(
            "INSERT INTO wallet_audit_events(id,owner_id,wallet_address,network,event_type,details,created_at) VALUES(?,?,?,'devnet','ownership_verified','{}',?)",
          )
          .bind(
            crypto.randomUUID(),
            i < 56 ? 'alice' : i === 56 ? 'bob' : '',
            receiptWallet,
            time,
          ),
      ),
    );
    const first = (await (await history(request('events'))).json()) as {
      events: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(first.events).toHaveLength(50);
    const second = (await (
      await history(
        request('events?cursor=' + encodeURIComponent(first.nextCursor)),
      )
    ).json()) as { events: Array<{ id: string }>; nextCursor: null };
    expect(second.events).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.events, ...second.events].map((e) => e.id)).size,
    ).toBe(56);
    expect((await history(request('events?cursor=invalid'))).status).toBe(400);
    expect(
      (await history(request('events?distributionKey=' + 'a'.repeat(64))))
        .status,
    ).toBe(400);
  });
  it('requires recent ownership before reading RPC evidence', async () => {
    expect(
      (
        await receipt(
          request('events', {
            address: receiptWallet,
            signature: receiptSignature,
          }),
        )
      ).status,
    ).toBe(403);
    await prove();
    await mocks.db
      .prepare(
        "UPDATE wallet_audit_events SET created_at='2020-01-01T00:00:00.000Z'",
      )
      .run();
    expect(
      (
        await receipt(
          request('events', {
            address: receiptWallet,
            signature: receiptSignature,
          }),
        )
      ).status,
    ).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('stores verified exact token receipts and makes retries idempotent without another provider read', async () => {
    await prove();
    mocks.transaction.mockResolvedValue(await tokenReceiptFixture());
    const body = {
      address: receiptWallet,
      signature: receiptSignature,
      distribution: receiptClaim,
      recipient: receiptRecipient,
    };
    const response = await receipt(request('events', body));
    expect(response.status).toBe(200);
    const saved = (await response.json()) as {
      event: { details: string; eventType: string };
    };
    expect(saved.event.eventType).toBe('token_transfer_finalized');
    expect(JSON.parse(saved.event.details)).toMatchObject({
      amount: '0.300000001',
      rawAmount: '300000001',
    });
    expect((await receipt(request('events', body))).status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(
      (
        await receipt(
          request('events', {
            address: receiptWallet,
            signature: receiptSignature,
          }),
        )
      ).status,
    ).toBe(409);
    const key = await distributionAuditKey(receiptClaim);
    const filtered = (await (
      await history(
        request(`events?address=${receiptWallet}&distributionKey=${key}`),
      )
    ).json()) as { events: unknown[] };
    expect(filtered.events).toHaveLength(1);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect(
      (
        (await (await history(request('events'))).json()) as {
          events: unknown[];
        }
      ).events,
    ).toHaveLength(0);
  });
  it('does not store pending or mismatched receipts and permits verification of the same existing signature later', async () => {
    await prove();
    mocks.transaction.mockRejectedValueOnce(
      new ReceiptError('Not finalized', 404),
    );
    const body = { address: receiptWallet, signature: receiptSignature };
    expect((await receipt(request('events', body))).status).toBe(404);
    await mocks.db.prepare('DELETE FROM wallet_receipt_gates').run();
    mocks.transaction.mockResolvedValue(memoReceiptFixture());
    expect((await receipt(request('events', body))).status).toBe(200);
    expect(
      (await mocks.db
        .prepare(
          'SELECT COUNT(*) AS n FROM wallet_audit_events WHERE transaction_signature IS NOT NULL',
        )
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });
  it('rechecks ownership after a slow provider call before storing evidence', async () => {
    await prove();
    mocks.transaction.mockImplementation(async () => {
      await mocks.db
        .prepare(
          "UPDATE wallet_audit_events SET created_at='2020-01-01T00:00:00.000Z'",
        )
        .run();
      return memoReceiptFixture();
    });
    expect(
      (
        await receipt(
          request('events', {
            address: receiptWallet,
            signature: receiptSignature,
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await mocks.db
        .prepare(
          'SELECT COUNT(*) AS n FROM wallet_audit_events WHERE transaction_signature IS NOT NULL',
        )
        .first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it('rejects oversized streams and cross-origin mutations before storage', async () => {
    expect(
      (
        await challenge(
          new Request('http://localhost/api/wallet/challenge', {
            method: 'POST',
            body: ' '.repeat(4097),
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await challenge(
          new Request('http://localhost/api/wallet/challenge', {
            method: 'POST',
            headers: { origin: 'https://other.test' },
            body: JSON.stringify({ address: receiptWallet }),
          }),
        )
      ).status,
    ).toBe(400);
  });
});
