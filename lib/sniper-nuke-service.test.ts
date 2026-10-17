import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  cancelSniperNuke,
  observeSniperNuke,
  prepareSniperNuke,
  registerSniperNuke,
  sendSniperNukeSell,
  type SniperNukeSellPreparer,
} from './sniper-nuke-service';
import { signSniperNukeBatch, sniperNukeConsent } from './sniper-nuke';
import type { SniperGuardRpc } from './sniper-guard-chain';
import type { VaultSession } from './browser-wallet-vault';
import type { WarmupSigningReview } from './warmup-signing';
import { PUMP_NATIVE_QUOTE } from './pump-launch-config';

const REVIEW = 'review-1';
const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const seeds = [new Uint8Array(32).fill(21), new Uint8Array(32).fill(22)];
const pairs = seeds.map((s) => nacl.sign.keyPair.fromSeed(s));
const dev = bs58.encode(pairs[0].publicKey),
  holder = bs58.encode(pairs[1].publicKey),
  mint = key(50);
const hex = (b: Uint8Array) =>
  Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
const session = {
  payload: {
    wallets: seeds.map((seed, i) => ({
      family: 'solana',
      address: bs58.encode(pairs[i].publicKey),
      seed: hex(seed),
    })),
  },
} as unknown as VaultSession;

async function reviewFor(
  wallet: string,
  amountRaw: string,
): Promise<WarmupSigningReview> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(wallet), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(key(60)), lastValidBlockHeight: 1000n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstruction(
        {
          programAddress: address(
            'ComputeBudget111111111111111111111111111111',
          ),
          data: new Uint8Array([2, 64, 13, 3, 0]),
        },
        m,
      ),
  );
  const bytes = new Uint8Array(
    getTransactionEncoder().encode(compileTransaction(message)),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return {
    id: crypto.randomUUID(),
    preparationId: crypto.randomUUID(),
    wallet,
    sha256: hex(digest),
    network: 'mainnet',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maximumFeeLamports: '5000',
    inputRaw: amountRaw,
    minimumOutputRaw: '1',
    inputMint: mint,
    outputMint: PUMP_NATIVE_QUOTE,
    transaction: getBase64Decoder().decode(bytes),
    lastValidBlockHeight: '1000',
  };
}
const prepare: SniperNukeSellPreparer = async (input) =>
  reviewFor(input.wallet, input.amountRaw);

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function database(guardState = 'triggered') {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec('CREATE TABLE pump_launch_reviews(id TEXT PRIMARY KEY);');
  sqlite.prepare('INSERT INTO pump_launch_reviews VALUES(?)').run(REVIEW);
  for (const file of ['0095_sniper_guards', '0099_sniper_nuke_sells'])
    for (const part of readFileSync(`drizzle/${file}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      sqlite.exec(part);
  // Insert a guard directly in its triggered state (bypassing transition triggers).
  sqlite.exec('DROP TRIGGER sniper_guard_insert_guard');
  sqlite
    .prepare(
      "INSERT INTO sniper_guards VALUES('guard-1','owner','project-1',?,3,?,?,?,?,'a','b','a','b')",
    )
    .run(
      REVIEW,
      guardState,
      JSON.stringify({
        format: 'sniper-guard-settings-v1',
        thresholdRaw: '1',
        response: { kind: 'nuke', scope: 'all' },
        end: { kind: 'timed', seconds: 5 },
        whitelist: [],
      }),
      JSON.stringify({
        mint,
        bondingCurve: key(40),
        quoteMint: PUMP_NATIVE_QUOTE,
        quoteDecimals: 9,
        quoteTokenProgram: null,
        developer: dev,
        holders: [holder],
      }),
      JSON.stringify({}),
    );
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first() {
          return sqlite.prepare(sql).get(...(values as never[])) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...(values as never[])) };
        },
        async run() {
          const r = sqlite.prepare(sql).run(...(values as never[]));
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: { run: () => Promise<unknown> }[]) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, db: db as unknown as D1Database };
}
const balances = (amounts: Record<string, string>) =>
  vi.fn<SniperGuardRpc>(async (method, params) => {
    if (method === 'getMultipleAccounts')
      return {
        value: [dev, holder].map((wallet) =>
          amounts[wallet] === '0'
            ? null
            : {
                data: {
                  parsed: {
                    info: {
                      mint,
                      owner: wallet,
                      tokenAmount: { amount: amounts[wallet], decimals: 6 },
                    },
                  },
                },
              },
        ),
      };
    if (method === 'getBlockHeight') return 2000;
    if (method === 'getSignatureStatuses')
      return { value: (params[0] as string[]).map(() => null) };
    throw new Error(method);
  });
const signal = () => new AbortController().signal;

describe('Sniper Guard Nuke batch', () => {
  it('prepares one full-balance sell per wallet, skipping empty wallets', async () => {
    const { db } = database();
    const batch = await prepareSniperNuke(
      db,
      'owner',
      REVIEW,
      balances({ [dev]: '5000000', [holder]: '0' }),
      signal(),
      prepare,
    );
    expect(
      batch.sells.map((s) => [s.wallet, s.review.inputRaw, s.state]),
    ).toEqual([[dev, '5000000', 'review']]);
    expect(batch.skipped).toEqual([
      { wallet: holder, reason: 'No tokens to sell.' },
    ]);
    const again = await prepareSniperNuke(
      db,
      'owner',
      REVIEW,
      balances({ [dev]: '5000000', [holder]: '0' }),
      signal(),
      prepare,
    );
    expect(again.batchId).toBe(batch.batchId);
  });
  it('refuses before the guard has triggered', async () => {
    const { db } = database('watching');
    await expect(
      prepareSniperNuke(db, 'owner', REVIEW, balances({}), signal(), prepare),
    ).rejects.toThrow('after Sniper Guard triggers');
  });
  it('reports a wallet whose sell could not be prepared', async () => {
    const { db } = database();
    const failing: SniperNukeSellPreparer = async (input) => {
      if (input.wallet === holder) throw new Error('No route.');
      return reviewFor(input.wallet, input.amountRaw);
    };
    const batch = await prepareSniperNuke(
      db,
      'owner',
      REVIEW,
      balances({ [dev]: '1', [holder]: '2' }),
      signal(),
      failing,
    );
    expect(batch.sells).toHaveLength(1);
    expect(batch.skipped).toEqual([{ wallet: holder, reason: 'No route.' }]);
  });
  it('signs every sell locally in one step and registers them together', async () => {
    const { db, sqlite } = database();
    const batch = await prepareSniperNuke(
      db,
      'owner',
      REVIEW,
      balances({ [dev]: '7', [holder]: '9' }),
      signal(),
      prepare,
    );
    const signed = await signSniperNukeBatch(session, batch, () => {});
    expect(signed).toHaveLength(2);
    const registered = await registerSniperNuke(
      db,
      'owner',
      REVIEW,
      sniperNukeConsent(batch),
      signed,
    );
    expect(
      registered.sells.every((s) => s.state === 'signed' && s.signature),
    ).toBe(true);
    expect(() =>
      sqlite.exec("UPDATE sniper_nuke_sells SET state='review'"),
    ).toThrow('not allowed');
    expect(() => sqlite.exec('DELETE FROM sniper_nuke_sells')).toThrow(
      'retained',
    );
  });
  it('signs nothing when any wallet is missing from the vault', async () => {
    const { db } = database();
    const batch = await prepareSniperNuke(
      db,
      'owner',
      REVIEW,
      balances({ [dev]: '7', [holder]: '9' }),
      signal(),
      prepare,
    );
    const partial = {
      payload: { wallets: [session.payload.wallets[0]] },
    } as unknown as VaultSession;
    await expect(signSniperNukeBatch(partial, batch, () => {})).rejects.toThrow(
      'Nothing was signed',
    );
  });
  it('rejects a partial set, a swapped transaction or a stale consent', async () => {
    const { db } = database();
    const batch = await prepareSniperNuke(
      db,
      'owner',
      REVIEW,
      balances({ [dev]: '7', [holder]: '9' }),
      signal(),
      prepare,
    );
    const signed = await signSniperNukeBatch(session, batch, () => {});
    await expect(
      registerSniperNuke(
        db,
        'owner',
        REVIEW,
        sniperNukeConsent(batch),
        signed.slice(0, 1),
      ),
    ).rejects.toThrow('every sell');
    const swapped = [
      { ...signed[0], transaction: signed[1].transaction },
      { ...signed[1], transaction: signed[0].transaction },
    ];
    await expect(
      registerSniperNuke(
        db,
        'owner',
        REVIEW,
        sniperNukeConsent(batch),
        swapped,
      ),
    ).rejects.toThrow('differs');
    const consent = sniperNukeConsent(batch);
    consent.sells[0].sha256 = '0'.repeat(64);
    await expect(
      registerSniperNuke(db, 'owner', REVIEW, consent, signed),
    ).rejects.toThrow('every sell');
  });
  it('expires unsent sells after their block height and can discard an unsigned batch', async () => {
    const { db } = database();
    const batch = await prepareSniperNuke(
      db,
      'owner',
      REVIEW,
      balances({ [dev]: '7', [holder]: '0' }),
      signal(),
      prepare,
    );
    const observed = await observeSniperNuke(
      db,
      'owner',
      REVIEW,
      batch.batchId,
      balances({}),
      signal(),
    );
    expect(observed.sells[0].state).toBe('expired');
    const fresh = await prepareSniperNuke(
      db,
      'owner',
      REVIEW,
      balances({ [dev]: '7', [holder]: '0' }),
      signal(),
      prepare,
    );
    expect(fresh.batchId).not.toBe(batch.batchId);
    const cancelled = await cancelSniperNuke(
      db,
      'owner',
      REVIEW,
      fresh.batchId,
    );
    expect(cancelled.sells[0].state).toBe('cancelled');
  });
  it('sends each signed sell exactly once and never resends an unknown outcome', async () => {
    const { db } = database();
    const batch = await prepareSniperNuke(
      db,
      'owner',
      REVIEW,
      balances({ [dev]: '7', [holder]: '9' }),
      signal(),
      prepare,
    );
    const registered = await registerSniperNuke(
      db,
      'owner',
      REVIEW,
      sniperNukeConsent(batch),
      await signSniperNukeBatch(session, batch, () => {}),
    );
    const [first, second] = registered.sells;
    const ok = vi.fn<SniperGuardRpc>(async () => first.signature);
    let after = await sendSniperNukeSell(
      db,
      'owner',
      REVIEW,
      batch.batchId,
      first.id,
      ok,
      signal(),
    );
    expect(after.sells.find((s) => s.id === first.id)!.state).toBe('submitted');
    await sendSniperNukeSell(
      db,
      'owner',
      REVIEW,
      batch.batchId,
      first.id,
      ok,
      signal(),
    );
    expect(ok).toHaveBeenCalledTimes(1);
    const lost = vi.fn<SniperGuardRpc>(async () => {
      throw new Error('timeout');
    });
    after = await sendSniperNukeSell(
      db,
      'owner',
      REVIEW,
      batch.batchId,
      second.id,
      lost,
      signal(),
    );
    expect(after.sells.find((s) => s.id === second.id)!.state).toBe(
      'submitting',
    );
    await sendSniperNukeSell(
      db,
      'owner',
      REVIEW,
      batch.batchId,
      second.id,
      lost,
      signal(),
    );
    expect(lost).toHaveBeenCalledTimes(1);
  });
  it('refuses to send unsigned or expired sells', async () => {
    const { db } = database();
    const batch = await prepareSniperNuke(
      db,
      'owner',
      REVIEW,
      balances({ [dev]: '7', [holder]: '0' }),
      signal(),
      prepare,
    );
    const rpc = vi.fn<SniperGuardRpc>();
    await sendSniperNukeSell(
      db,
      'owner',
      REVIEW,
      batch.batchId,
      batch.sells[0].id,
      rpc,
      signal(),
    );
    await registerSniperNuke(
      db,
      'owner',
      REVIEW,
      sniperNukeConsent(batch),
      await signSniperNukeBatch(session, batch, () => {}),
    );
    await expect(
      sendSniperNukeSell(
        db,
        'owner',
        REVIEW,
        batch.batchId,
        batch.sells[0].id,
        rpc,
        signal(),
        new Date(Date.now() + 120_000),
      ),
    ).rejects.toThrow('expired');
    expect(rpc).not.toHaveBeenCalled();
  });
});
