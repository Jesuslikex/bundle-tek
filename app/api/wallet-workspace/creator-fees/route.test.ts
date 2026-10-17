import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { creatorFeeFixture, USDC } from '../../../../test/creator-fee-fixture';
import {
  inspectCreatorFeeClaim,
  signCreatorFeeClaim,
  CLAIM_WSOL,
} from '@/lib/pump-creator-fees';
import type { VaultSession } from '@/lib/browser-wallet-vault';
import type {
  CreatorFeeClaimReceipt,
  CreatorFeeClaimReview,
} from '@/lib/pump-creator-fees';
import type { CreatorFeeScan } from '@/lib/pump-creator-fees-server';
type Json = {
  review: CreatorFeeClaimReview;
  scan: CreatorFeeScan;
  receipt: CreatorFeeClaimReceipt;
  signature: string;
  error: string;
};
const read = async (r: Response) => (await r.json()) as Json;

const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  owned: true,
  reserved: false,
  queries: [] as { sql: string; args: unknown[] }[],
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({
  getD1: () => ({
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          mocks.queries.push({ sql, args });
          if (sql.includes('workspace_wallets'))
            return mocks.owned && (args[2] === null || args[2] === 2)
              ? { address: args[1] }
              : null;
          if (sql.includes('solana_execution_reservations'))
            return mocks.reserved ? { intent_id: 'x' } : null;
          return null;
        },
      }),
    }),
  }),
}));
import { POST } from './route';

let f: Awaited<ReturnType<typeof creatorFeeFixture>>;
const ALL = [
  'pump-sol:' + CLAIM_WSOL,
  'pump-token:' + USDC,
  'amm-token:' + CLAIM_WSOL,
];
const call = (body: unknown, origin = 'https://bundle.test') =>
  POST(
    new Request('https://bundle.test/api/wallet-workspace/creator-fees', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const sends = () => f.calls.filter((c) => c.method === 'sendTransaction');
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  mocks.owned = true;
  mocks.reserved = false;
  mocks.queries = [];
  f = await creatorFeeFixture();
  vi.stubGlobal('fetch', f.fetcher);
});
afterEach(() => vi.unstubAllGlobals());

async function prepared() {
  const response = await call({
    action: 'prepare',
    wallet: f.wallet,
    walletRevision: 2,
    select: ALL,
  });
  expect(response.status).toBe(200);
  const { review } = await read(response);
  const signed = await signCreatorFeeClaim(
    {
      payload: {
        wallets: [
          {
            family: 'solana',
            address: f.wallet,
            seed: Buffer.from(f.seed).toString('hex'),
          },
        ],
      },
    } as unknown as VaultSession,
    review,
    () => {},
  );
  return { review, signed };
}

it('requires sign-in, a same-origin request and a known action', async () => {
  mocks.user = null;
  expect((await call({ action: 'scan', wallet: f.wallet })).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (await call({ action: 'scan', wallet: f.wallet }, 'https://evil.test'))
      .status,
  ).toBe(400);
  expect((await call({ action: 'claim_all', wallet: f.wallet })).status).toBe(
    400,
  );
  expect(f.calls).toHaveLength(0);
});

it('scans only wallets in the signed-in workspace', async () => {
  mocks.owned = false;
  expect((await call({ action: 'scan', wallet: f.wallet })).status).toBe(409);
  expect(f.calls).toHaveLength(0);
  mocks.owned = true;
  const response = await call({ action: 'scan', wallet: f.wallet });
  expect(response.status).toBe(200);
  const { scan } = await read(response);
  expect(scan.vaults).toHaveLength(3);
  expect(mocks.queries[0].args).toContain('alice');
});

it('refuses to prepare while the wallet holds another retained approval', async () => {
  mocks.reserved = true;
  const response = await call({
    action: 'prepare',
    wallet: f.wallet,
    walletRevision: 2,
    select: ALL,
  });
  expect(response.status).toBe(409);
  expect((await read(response)).error).toMatch(/retained approval/);
  expect(f.calls).toHaveLength(0);
});

it('validates selections before reading the chain', async () => {
  for (const select of [[], ['everything'], Array(7).fill(ALL[0])])
    expect(
      (
        await call({
          action: 'prepare',
          wallet: f.wallet,
          walletRevision: 2,
          select,
        })
      ).status,
    ).toBe(400);
  expect(f.calls).toHaveLength(0);
});

it('sends only the browser-signed reviewed packet, once', async () => {
  const { review, signed } = await prepared();
  expect(sends()).toHaveLength(0);
  // Unsigned and altered packets are refused before any send.
  expect(
    (await call({ action: 'submit', review, transaction: review.transaction }))
      .status,
  ).toBe(400);
  expect(
    (
      await call({
        action: 'submit',
        review: { ...review, walletRevision: 9 },
        transaction: signed.transaction,
      })
    ).status,
  ).toBe(409);
  expect(sends()).toHaveLength(0);
  f.state.sendResult = signed.signature;
  const response = await call({
    action: 'submit',
    review,
    transaction: signed.transaction,
  });
  expect(response.status).toBe(200);
  expect(await read(response)).toEqual({ signature: signed.signature });
  expect(sends()).toHaveLength(1);
  expect(sends()[0].params[1]).toMatchObject({ maxRetries: 0 });
});

it('reports an unknown outcome when the provider answers unexpectedly', async () => {
  const { review, signed } = await prepared();
  f.state.sendResult = 'other';
  const response = await call({
    action: 'submit',
    review,
    transaction: signed.transaction,
  });
  expect(response.status).toBe(502);
  expect((await read(response)).error).toMatch(/outcome is unknown/);
});

it('does not send when the fresh recheck fails', async () => {
  const { review, signed } = await prepared();
  f.state.blockhashValid = false;
  const response = await call({
    action: 'submit',
    review,
    transaction: signed.transaction,
  });
  expect(response.status).toBe(502);
  expect(sends()).toHaveLength(0);
});

it('recovers finalized receipts and keeps waiting while unavailable', async () => {
  const { review, signed } = await prepared();
  f.state.transaction = null;
  const pending = await call({
    action: 'recover',
    review,
    signature: signed.signature,
  });
  expect(pending.status).toBe(409);
  expect((await read(pending)).error).toMatch(/do not resend/);
  const keys = (await inspectCreatorFeeClaim(review, signed.transaction, true))
    .accountKeys.length;
  f.state.transaction = {
    slot: 1500,
    blockTime: null,
    version: 'legacy',
    transaction: [signed.transaction, 'base64'],
    meta: {
      err: null,
      fee: 5000,
      preBalances: Array(keys)
        .fill(0)
        .map((_, i) => (i ? 1 : 1_000_000_000)),
      postBalances: Array(keys)
        .fill(0)
        .map((_, i) =>
          i ? 1 : 1_000_000_000 + 290_000_000 - 5000 - 2_039_280,
        ),
      preTokenBalances: [],
      postTokenBalances: [],
    },
  };
  const done = await call({
    action: 'recover',
    review,
    signature: signed.signature,
  });
  const body = await read(done);
  expect(done.status, JSON.stringify(body)).toBe(200);
  expect(body.receipt.walletChangeLamports).toBe(
    String(290_000_000 - 5000 - 2_039_280),
  );
  expect(sends()).toHaveLength(0);
});
