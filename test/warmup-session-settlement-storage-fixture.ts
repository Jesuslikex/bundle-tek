import { readFileSync } from 'node:fs';
import { warmupSessionConsentFixture } from './warmup-session-consent-fixture';
import { warmupSessionSettlementFixture } from './warmup-session-settlement-fixture';
import { buildWarmupPlan } from '@/lib/wallet-warmup';
import { retainWalletWarmupSessionConsent } from '@/lib/wallet-warmup-session-consent';
import {
  retainWalletWarmupSessionJournal,
  appendWalletWarmupSessionJournal,
} from '@/lib/wallet-warmup-session-journal-storage';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import { retainWalletWarmupSessionActionBinding } from '@/lib/wallet-warmup-session-action-binding';
const signal = () => new AbortController().signal;

/** In-memory SQL and synthetic signed transfer packets only, NOT a live DEX/funded swap. */
export async function warmupSessionSettlementStorageFixture(
  reserve = '0.01',
  options: { bindBuy?: boolean; reviewOnly?: boolean } = {},
) {
  const packets = await warmupSessionSettlementFixture();
  const at = Date.now(),
    date = new Date(at).toISOString();
  const input = {
    chain: 'Solana',
    name: 'Synthetic durable settlement',
    addresses: [packets.wallet],
    walletRevisions: [{ address: packets.wallet, revision: 1 }],
    tokens: [packets.mint],
    cycles: 1,
    amount: '0.001',
    feeReserve: reserve,
    intervalSeconds: 10,
    startAt: date,
  };
  const plan: SavedWarmup = {
    id: 'synthetic-settlement',
    revision: 1,
    archived: false,
    updatedAt: date,
    document: { ...input, totalBudget: buildWarmupPlan(input, at).totalBudget },
  };
  const f = await warmupSessionConsentFixture(plan);
  try {
    for (const sql of [
      'ALTER TABLE warmup_buy_receipts ADD COLUMN preparation_id TEXT',
      'ALTER TABLE warmup_sell_receipts ADD COLUMN preparation_id TEXT',
      'CREATE UNIQUE INDEX fixture_buy_id ON warmup_buy_receipts(id)',
      'CREATE UNIQUE INDEX fixture_sell_id ON warmup_sell_receipts(id)',
      'CREATE UNIQUE INDEX fixture_buy_preparation ON warmup_buy_receipts(owner_id,preparation_id)',
      'CREATE UNIQUE INDEX fixture_sell_preparation ON warmup_sell_receipts(owner_id,preparation_id)',
    ])
      await f.db.prepare(sql).run();
    for (const name of [
      '0042_warmup_swap_preparations',
      '0045_warmup_signing_intents',
      '0124_wallet_warmup_session_journals',
      '0125_wallet_warmup_session_settlements',
      '0126_wallet_warmup_session_action_bindings',
    ])
      for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((v) => v.trim())
        .filter(Boolean))
        await f.db.prepare(sql).run();
    const consent = await retainWalletWarmupSessionConsent(
      f.db,
      'owner',
      f.input,
      true,
      signal(),
    );
    const rootInput = {
      id: crypto.randomUUID(),
      consentId: consent.id,
      termsSha256: consent.termsSha256,
    };
    let journal = await retainWalletWarmupSessionJournal(
      f.db,
      'owner',
      rootInput,
      true,
      signal(),
    );
    let logical = Date.now();
    const clock = () => logical;
    const append = async (operation: string, actionId?: string) => {
      if (operation === 'submitted' && actionId?.startsWith('Sell:'))
        await bindAction(packets.sell);
      journal = await appendWalletWarmupSessionJournal(
        f.db,
        'owner',
        {
          id: crypto.randomUUID(),
          journalId: rootInput.id,
          expectedVersion: journal.version,
          expectedHeadSha256: journal.headSha256,
          command: { operation, ...(actionId ? { actionId } : {}) },
        },
        signal(),
        clock,
      );
      return journal;
    };
    const actionId = JSON.parse(journal.sourceDocument).review.actions[0].id;
    await append('begin-review', actionId);
    for (const part of [packets.buy, packets.sell]) {
      const p = part.preparation;
      p.createdAt = new Date(logical).toISOString();
      await f.db
        .prepare(
          'INSERT INTO warmup_swap_preparations(id,owner_id,plan_id,plan_revision,cycle,wallet_revision,created_at,document,wallet_address) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          p.id,
          'owner',
          p.planId,
          p.planRevision,
          p.cycle,
          p.walletRevision,
          p.createdAt,
          JSON.stringify(p.document),
          packets.wallet,
        )
        .run();
    }
    async function bindAction(part: typeof packets.buy) {
      const p = part.preparation;
      p.createdAt = new Date(logical).toISOString();
      await f.db
        .prepare('UPDATE warmup_swap_preparations SET created_at=? WHERE id=?')
        .bind(p.createdAt, p.id)
        .run();
      const binding = await retainWalletWarmupSessionActionBinding(
        f.db,
        'owner',
        {
          journalId: journal.id,
          version: journal.version,
          headSha256: journal.headSha256,
          preparationId: p.id,
        },
        signal(),
        clock,
      );
      await f.db
        .prepare(
          'INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,signature,state,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          part.approval.id,
          'owner',
          p.id,
          packets.wallet,
          part.signature,
          'finalized',
          JSON.stringify(part.approval),
          new Date(logical).toISOString(),
          new Date(logical).toISOString(),
        )
        .run();
      return binding;
    }
    if (!options.reviewOnly) {
      if (options.bindBuy !== false) await bindAction(packets.buy);
      await append('submitted', actionId);
    }
    const installBuy = async () => {
      await f.db
        .prepare(
          'INSERT INTO warmup_buy_receipts(owner_id,plan_id,id,plan_revision,wallet_revision,cycle,wallet_address,signature,remaining_raw,document,preparation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          'owner',
          plan.id,
          packets.buy.receiptId,
          1,
          1,
          1,
          packets.wallet,
          packets.buy.signature,
          '101',
          JSON.stringify(packets.buyDocument),
          packets.buy.preparation.id,
        )
        .run();
    };
    if (!options.reviewOnly) await installBuy();
    const installSell = async () => {
      await f.db
        .prepare("UPDATE warmup_buy_receipts SET remaining_raw='0'")
        .run();
      await f.db
        .prepare(
          'INSERT INTO warmup_sell_receipts(owner_id,plan_id,id,buy_receipt_id,consumed_raw,signature,document,preparation_id) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(
          'owner',
          plan.id,
          packets.sell.receiptId,
          packets.buy.receiptId,
          '101',
          packets.sell.signature,
          JSON.stringify(packets.sellDocument),
          packets.sell.preparation.id,
        )
        .run();
    };
    const methods: string[] = [];
    let hook: (() => Promise<void>) | undefined,
      throttled = false;
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      methods.push(body.method);
      if (throttled) return new Response('throttled', { status: 429 });
      let result: unknown;
      if (body.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
      else if (body.method === 'getTransaction') {
        if (
          body.params[0] !== packets.buy.signature &&
          body.params[0] !== packets.sell.signature
        )
          throw Error('Unexpected synthetic signature');
        result = structuredClone(
          body.params[0] === packets.buy.signature
            ? packets.buy.raw
            : packets.sell.raw,
        );
        await hook?.();
      } else throw Error('Unexpected synthetic provider method');
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    };
    return {
      ...f,
      packets,
      rootInput,
      journal,
      clock,
      methods,
      fetcher,
      installSell,
      installBuy,
      append,
      bindAction,
      advance: (ms: number) => {
        logical += ms;
      },
      setJournal: (value: typeof journal) => {
        journal = value;
      },
      setHook: (value: typeof hook) => {
        hook = value;
      },
      throttle: () => {
        throttled = true;
      },
      request: (receiptId = packets.buy.receiptId) => ({
        id: crypto.randomUUID(),
        journalId: rootInput.id,
        version: journal.version,
        headSha256: journal.headSha256,
        receiptId,
      }),
    };
  } catch (error) {
    f.client.close();
    throw error;
  }
}
