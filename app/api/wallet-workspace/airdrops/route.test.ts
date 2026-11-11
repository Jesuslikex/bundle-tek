import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  airdropChain,
  airdropSession,
  CREATOR,
  MINT,
  OUT1,
  OUT2,
  OUT3,
} from '../../../../test/token-airdrop-fixture';
import {
  solanaFamilyExclusionFixture,
  familyExclusionD1,
  exclusionOwner,
  reserveFamily,
} from '../../../../test/solana-family-exclusion-fixture';

const mocks = vi.hoisted(() => ({
  user: { userId: 'storage-owner' } as { userId: string } | null,
  db: null as unknown as D1Database,
  fetcher: null as unknown as typeof fetch,
  rpc: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/token-airdrop-server', async (original) => {
  const actual = await original<typeof import('@/lib/token-airdrop-server')>();
  return {
    ...actual,
    prepareAirdrop: (
      input: Parameters<typeof actual.prepareAirdrop>[0],
      signal: AbortSignal,
    ) => actual.prepareAirdrop(input, signal, mocks.fetcher),
    recheckAirdrop: (
      review: Parameters<typeof actual.recheckAirdrop>[0],
      signal: AbortSignal,
    ) => actual.recheckAirdrop(review, signal, mocks.fetcher),
  };
});
vi.mock('@/lib/wallet-balances', async (original) => {
  const actual = await original<typeof import('@/lib/wallet-balances')>();
  return {
    ...actual,
    balanceRpc: (...args: Parameters<typeof actual.balanceRpc>) =>
      args[4] !== fetch ? actual.balanceRpc(...args) : mocks.rpc(...args),
  };
});
import { GET, POST } from './route';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import {
  AIRDROP_CLAWBACK_DELAY_SECONDS,
  signAirdrop,
  type TokenAirdropAction,
} from '@/lib/token-airdrop';

let sqlite: DatabaseSync;
let fake: ReturnType<typeof airdropChain>;
const URL_ = 'https://bundle.test/api/wallet-workspace/airdrops';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  sqlite = solanaFamilyExclusionFixture();
  mocks.db = familyExclusionD1(sqlite);
  mocks.user = { userId: exclusionOwner };
  for (const wallet of [CREATOR, OUT1, OUT2, OUT3])
    sqlite
      .prepare(`INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,updated_at)
    VALUES(?,'Solana',?,'','Synthetic','trading',?)`)
      .run(exclusionOwner, wallet, new Date().toISOString());
  fake = airdropChain();
  mocks.fetcher = fake.fetcher;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('Real networking is forbidden in this test');
    }),
  );
  mocks.rpc.mockReset();
});
afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const post = async (body: object) => {
  const response = await POST(
    new Request(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://bundle.test',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      action: TokenAirdropAction;
      error?: string;
    },
  };
};
const create = (extra: object = {}) =>
  post({
    action: 'prepare_create',
    wallet: CREATOR,
    walletRevision: 1,
    mint: MINT,
    percent: '30',
    recipients: [OUT1, OUT2, OUT3],
    acknowledgeAirdrop: true,
    ...extra,
  });
/** Signs in the "browser", registers, submits and recovers the finalized receipt. */
async function settle(action: TokenAirdropAction, tokenChange: bigint) {
  const review = action.document;
  mocks.rpc.mockClear();
  expect((await post({ action: 'begin_signing', id: action.id })).status).toBe(
    200,
  );
  const signed = await signAirdrop(airdropSession, review, () => {});
  const registered = await post({
    action: 'register',
    id: action.id,
    transaction: signed.transaction,
  });
  expect(registered.body.action.state).toBe('signed');
  mocks.rpc.mockImplementation(async (_e: string, method: string) => {
    if (method === 'sendTransaction') return signed.signature;
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getTransaction')
      return {
        transaction: [signed.transaction, 'base64'],
        slot: 120,
        blockTime: 1,
        meta: {
          err: null,
          fee: 5000,
          preBalances: [1_000_000_000],
          postBalances: [1_000_000_000 - 5000],
          preTokenBalances:
            tokenChange < 0n
              ? [
                  {
                    accountIndex: 1,
                    mint: MINT,
                    owner: review.wallet,
                    uiTokenAmount: { amount: (-tokenChange).toString() },
                  },
                ]
              : [],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: review.wallet,
              uiTokenAmount: {
                amount: (tokenChange < 0n ? 0n : tokenChange).toString(),
              },
            },
          ],
        },
      };
    throw Error('unexpected ' + method);
  });
  const sent = await post({
    action: 'submit',
    id: action.id,
    transaction: signed.transaction,
  });
  expect(sent.body.action.state).toBe('submitted');
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(1);
  const done = await post({ action: 'recover', id: action.id });
  expect(done.body.action.state).toBe('finalized');
  return done.body.action;
}
async function created(prepared?: TokenAirdropAction) {
  const first = prepared ?? (await create()).body.action;
  expect(first?.kind).toBe('create');
  const action = await settle(first, -300_000_000n);
  fake.state.created = true;
  fake.state.vault = 300_000_000n;
  fake.state.balances[CREATOR] -= 300_000_000n;
  mocks.rpc.mockClear();
  return action;
}

it('runs create, claim and take-back as separately reviewed, signed and submitted steps', async () => {
  const first = await create();
  expect(first.status).toBe(200);
  const review = first.body.action.document;
  expect(review).toMatchObject({
    kind: 'create',
    wallet: CREATOR,
    amount: '300',
    tokenChangeRaw: '-300000000',
    percentPpm: '300000',
  });
  expect(review.terms).toMatchObject({
    perRecipientRaw: '100000000',
    recipients: [OUT1, OUT2, OUT3],
    creator: CREATOR,
    airdropId: review.id,
  });
  // Preparing never signs or sends.
  expect(fake.calls).toContain('simulateTransaction');
  expect(mocks.rpc).not.toHaveBeenCalled();
  // A claim cannot be prepared before the create is finalized.
  expect(
    (
      await post({
        action: 'prepare_claim',
        airdropId: review.id,
        wallet: OUT1,
        walletRevision: 1,
      })
    ).body.error,
  ).toContain('not finalized');
  const parent = await created(first.body.action);
  expect(parent.id).toBe(review.id);

  // Claims open only after the start time.
  const early = await post({
    action: 'prepare_claim',
    airdropId: parent.id,
    wallet: OUT1,
    walletRevision: 1,
  });
  expect(early.status).toBe(502);
  expect(early.body.error).toContain('Claims open at');
  vi.setSystemTime(review.terms.startTs * 1000 + 30_000);
  const claim = await post({
    action: 'prepare_claim',
    airdropId: parent.id,
    wallet: OUT1,
    walletRevision: 1,
  });
  expect(claim.status).toBe(200);
  expect(claim.body.action).toMatchObject({
    kind: 'claim',
    airdropId: parent.id,
    wallet: OUT1,
  });
  expect(claim.body.action.document.tokenChangeRaw).toBe('100000000');
  expect(claim.body.action.document.terms.proof!.length).toBe(2);
  await settle(claim.body.action, 100_000_000n);
  fake.state.claimed.push(OUT1);
  fake.state.vault -= 100_000_000n;
  fake.state.balances[OUT1] = 100_000_000n;
  // The same wallet cannot claim twice; an outsider cannot claim at all.
  const again = await post({
    action: 'prepare_claim',
    airdropId: parent.id,
    wallet: OUT1,
    walletRevision: 1,
  });
  expect(again.status).toBe(502);
  expect(again.body.error).toContain('already claimed');
  const outsider = await post({
    action: 'prepare_claim',
    airdropId: parent.id,
    wallet: CREATOR,
    walletRevision: 1,
  });
  expect(outsider.body.error).toContain('not an output wallet');

  // Take-back: creator only, and only after the clawback time.
  const soon = await post({
    action: 'prepare_clawback',
    airdropId: parent.id,
    wallet: CREATOR,
    walletRevision: 1,
  });
  expect(soon.body.error).toContain('can be taken back from');
  vi.setSystemTime(review.terms.clawbackTs * 1000 + 30_000);
  expect(review.terms.clawbackTs - review.terms.endTs).toBe(
    AIRDROP_CLAWBACK_DELAY_SECONDS,
  );
  const notCreator = await post({
    action: 'prepare_clawback',
    airdropId: parent.id,
    wallet: OUT2,
    walletRevision: 1,
  });
  expect(notCreator.body.error).toContain('Only the creating wallet');
  const back = await post({
    action: 'prepare_clawback',
    airdropId: parent.id,
    wallet: CREATOR,
    walletRevision: 1,
  });
  expect(back.status).toBe(200);
  expect(back.body.action.document).toMatchObject({
    kind: 'clawback',
    amount: '200',
    tokenChangeRaw: '200000000',
  });
  await settle(back.body.action, 200_000_000n);

  const history = await GET(new Request(`${URL_}?airdrop=${parent.id}`));
  const rows = ((await history.json()) as { actions: TokenAirdropAction[] })
    .actions;
  expect(rows.map((r) => [r.kind, r.state]).reverse()).toEqual([
    ['create', 'finalized'],
    ['claim', 'finalized'],
    ['clawback', 'finalized'],
  ]);
  const mine = await GET(new Request(`${URL_}?wallet=${CREATOR}`));
  expect(
    ((await mine.json()) as { actions: TokenAirdropAction[] }).actions,
  ).toHaveLength(1);
  expect(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM solana_execution_signatures WHERE scope='airdrop'",
      )
      .get(),
  ).toEqual({ n: 3 });
});

it('refuses unsafe create requests before anything is saved', async () => {
  expect((await create({ acknowledgeAirdrop: false })).status).toBe(400);
  expect((await create({ recipients: [OUT1, CREATOR] })).status).toBe(400);
  expect((await create({ walletRevision: 2 })).status).toBe(409);
  // Output wallets must be the user's own workspace wallets.
  const stranger = await create({
    recipients: [OUT1, 'SysvarRent111111111111111111111111111111111'],
  });
  expect(stranger.status).toBe(409);
  expect(stranger.body.error).toContain('Every output wallet');
  fake.state.transferFee = true;
  const fee = await create();
  expect(fee.status).toBe(502);
  expect(fee.body.error).toContain('Transfer-fee');
  fake.state.transferFee = false;
  fake.state.simulateErr = { InstructionError: [0, 'Custom'] };
  expect((await create()).body.error).toContain('simulation failed');
  fake.state.simulateErr = null;
  fake.state.balances[CREATOR] = 5n;
  expect((await create()).body.error).toContain('below one token unit');
  expect(
    sqlite.prepare('SELECT COUNT(*) AS n FROM token_airdrop_actions').get(),
  ).toEqual({ n: 0 });
  mocks.user = null;
  expect((await create()).status).toBe(401);
});

it('keeps one retained approval per wallet and refuses changed packets, late submits and cost increases', async () => {
  const first = await create();
  expect(first.status).toBe(200);
  expect((await create()).status).toBe(409);
  const action = first.body.action;
  // A burn or lock on the same wallet is blocked while the airdrop review is open, and the reverse.
  expect(() =>
    sqlite
      .prepare(
        "INSERT INTO solana_execution_reservations(owner_id,wallet_address,scope,intent_id,state) VALUES(?,?,'swap','x','reserved')",
      )
      .run(exclusionOwner, CREATOR),
  ).toThrow();
  // Burn/lock and cleanup on the same wallet are blocked while the airdrop review is open.
  expect(() =>
    reserveFamily(sqlite, 'supply', CREATOR, exclusionOwner),
  ).toThrow('Wallet already reserved');
  expect(() =>
    reserveFamily(sqlite, 'cleanup', CREATOR, exclusionOwner),
  ).toThrow('Wallet already reserved');
  // And an open burn on an output wallet blocks its claim review in the database.
  reserveFamily(sqlite, 'supply', OUT1, exclusionOwner);
  expect(() =>
    sqlite
      .prepare(
        "INSERT INTO token_airdrop_actions(id,owner_id,wallet_address,wallet_revision,kind,airdrop_id,mint,document,state,created_at,updated_at) VALUES('z',?,?,1,'create','z',?,?,'awaiting_signature','t','t')",
      )
      .run(
        exclusionOwner,
        OUT1,
        MINT,
        JSON.stringify({
          id: 'z',
          kind: 'create',
          mint: MINT,
          wallet: OUT1,
          terms: { airdropId: 'z' },
        }),
      ),
  ).toThrow('Wallet already reserved');
  await post({ action: 'begin_signing', id: action.id });
  const signed = await signAirdrop(airdropSession, action.document, () => {});
  const other = Uint8Array.from(atob(signed.transaction), (c) =>
    c.charCodeAt(0),
  );
  other[other.length - 1] ^= 1;
  expect(
    (
      await post({
        action: 'register',
        id: action.id,
        transaction: btoa(String.fromCharCode(...other)),
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  await post({
    action: 'register',
    id: action.id,
    transaction: signed.transaction,
  });
  // The cost rose since approval: submission stops and nothing is sent.
  fake.state.extraLamports = 1n;
  const dearer = await post({
    action: 'submit',
    id: action.id,
    transaction: signed.transaction,
  });
  expect(dearer.status).toBe(502);
  expect(dearer.body.error).toContain('changed since approval');
  fake.state.extraLamports = 0n;
  vi.setSystemTime(Date.now() + 61_000);
  expect(
    (
      await post({
        action: 'submit',
        id: action.id,
        transaction: signed.transaction,
      })
    ).status,
  ).toBe(409);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(() =>
    sqlite.prepare('DELETE FROM token_airdrop_actions').run(),
  ).toThrow('retained');
});

it('enforces the parent airdrop in the database itself', async () => {
  const parent = await created();
  const doc = (id: string, wallet: string, kind: string) =>
    JSON.stringify({
      id,
      kind,
      mint: MINT,
      wallet,
      terms: { airdropId: parent.id },
    });
  const insert = (
    id: string,
    wallet: string,
    kind: string,
    airdrop = parent.id,
  ) =>
    sqlite
      .prepare(
        "INSERT INTO token_airdrop_actions(id,owner_id,wallet_address,wallet_revision,kind,airdrop_id,mint,document,state,created_at,updated_at) VALUES(?,?,?,1,?,?,?,?,'awaiting_signature','t','t')",
      )
      .run(
        id,
        exclusionOwner,
        wallet,
        kind,
        airdrop,
        MINT,
        doc(id, wallet, kind),
      );
  expect(() => insert('a', CREATOR, 'claim')).toThrow('Airdrop parent');
  expect(() => insert('b', OUT1, 'clawback')).toThrow('Airdrop parent');
  expect(() => insert('c', OUT1, 'claim', 'c')).toThrow();
  insert('d', OUT1, 'claim');
  expect(() => insert('e', OUT1, 'claim')).toThrow();
});

it('releases a signed step that expired without ever landing, and only then', async () => {
  const first = await create();
  const action = first.body.action;
  await post({ action: 'begin_signing', id: action.id });
  const signed = await signAirdrop(airdropSession, action.document, () => {});
  await post({
    action: 'register',
    id: action.id,
    transaction: signed.transaction,
  });
  let height = 1999;
  mocks.rpc.mockImplementation(async (_e: string, method: string) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getTransaction') return null;
    if (method === 'getBlockHeight') return height;
    throw Error('unexpected ' + method);
  });
  // Still within its valid block height: stays reserved.
  const pending = await post({ action: 'recover', id: action.id });
  expect(pending.status).toBe(409);
  expect((await create()).status).toBe(409);
  height = 2001;
  const expired = await post({ action: 'recover', id: action.id });
  expect(expired.body.action).toMatchObject({ state: 'failed', receipt: null });
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(0);
  // The wallet is free again.
  expect((await create()).status).toBe(200);
});
