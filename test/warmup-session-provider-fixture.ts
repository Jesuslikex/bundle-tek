import { readFileSync } from 'node:fs';
import { warmupSessionSettlementStorageFixture } from './warmup-session-settlement-storage-fixture';
import { installWarmupSessionFinishGuards } from './warmup-session-finish-guard-fixture';
import type { ImportedSwapSimulation } from '@/lib/imported-swap-simulation';
import type { SolanaSwapPreparation } from '@/lib/warmup-swap-quote';
import { assessJupiterRoute } from '@/lib/jupiter-route-assessment';
import type { SwapInstructionReview } from '@/lib/swap-instruction-review';
import { assessWarmupSellInventory } from '@/lib/warmup-sell-inventory';
/** Native in-memory SQL and synthetic unsigned envelopes. No real DEX, wallet or provider. */
export async function warmupSessionProviderFixture(
  reserve = '0.01',
  reviewOnly = true,
) {
  const f = await warmupSessionSettlementStorageFixture(reserve, {
    reviewOnly,
  });
  try {
    await f.db
      .prepare('ALTER TABLE warmup_buy_receipts ADD COLUMN created_at TEXT')
      .run();
    await f.db
      .prepare('UPDATE warmup_buy_receipts SET created_at=?')
      .bind(new Date().toISOString())
      .run();
    for (const name of [
      '0128_wallet_warmup_session_preparations',
      '0129_wallet_warmup_session_packets',
      '0130_wallet_warmup_session_packet_freshness',
    ])
      for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean))
        await f.db.prepare(sql).run();
    await installWarmupSessionFinishGuards(f.db);
    for (const sql of readFileSync('drizzle/0012_messy_zzzax.sql', 'utf8')
      .split('--> statement-breakpoint')
      .slice(0, 2))
      await f.db.prepare(sql.trim()).run();
    return {
      ...f,
      input: () => ({
        id: crypto.randomUUID(),
        journalId: f.journal.id,
        version: f.journal.version,
        headSha256: f.journal.headSha256,
        prepareRequested: true,
      }),
      quote: (url: URL) => {
        const side =
          url.searchParams.get('inputMint') === f.packets.mint ? 'Sell' : 'Buy';
        return {
          inputMint: url.searchParams.get('inputMint'),
          outputMint: url.searchParams.get('outputMint'),
          inAmount: url.searchParams.get('amount'),
          outAmount: side === 'Buy' ? '101' : '1000000',
          otherAmountThreshold: side === 'Buy' ? '100' : '995000',
          swapMode: 'ExactIn',
          slippageBps: 50,
          router: 'metis',
          taker: f.packets.wallet,
          gasless: false,
          transactionVersion: 0,
          transaction:
            f.packets[side === 'Buy' ? 'buy' : 'sell'].approval.transaction,
          lastValidBlockHeight: '200',
          signatureFeeLamports: 5000,
          signatureFeePayer: f.packets.wallet,
          prioritizationFeeLamports: 0,
          prioritizationFeePayer: f.packets.wallet,
          rentFeeLamports: 0,
          rentFeePayer: f.packets.wallet,
        };
      },
      inventory: (amount: string) =>
        assessWarmupSellInventory(
          {
            chain: 'Solana',
            address: f.packets.wallet,
            holdings: [
              {
                mint: f.packets.mint,
                program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                decimals: 6,
                raw: '101',
                accounts: [
                  {
                    address: '11111111111111111111111111111111',
                    raw: '101',
                    frozen: false,
                  },
                ],
              },
            ],
            minSlot: 301,
            maxSlot: 301,
            observedAt: new Date().toISOString(),
            source: 'synthetic.fixture',
          } as Parameters<typeof assessWarmupSellInventory>[0],
          f.packets.wallet,
          f.packets.mint,
          amount,
        ),
      simulation: (order: SolanaSwapPreparation): ImportedSwapSimulation => {
        const instructionReview: SwapInstructionReview = {
          instructionsVerified: false,
          executionAllowed: false,
          unresolvedAccountCount: 0,
          unrecognizedInstructionCount: 0,
          authorityActionCount: 0,
          instructions: [],
          limitations: 'Synthetic unqualified instruction metadata.',
        };
        return {
          executionAllowed: false,
          instructionsVerified: false,
          sha256: order.preparation.sha256,
          wallet: f.packets.wallet,
          succeeded: true,
          network: 'Solana mainnet',
          source: 'synthetic.fixture',
          observedAt: new Date().toISOString(),
          feeSlot: 301,
          simulationSlot: 302,
          blockHeight: '100',
          networkFeeLamports: '5000',
          unitsConsumed: '1000',
          nativeChangeRaw: order.side === 'Buy' ? '-1005000' : '995000',
          instructionReview,
          routeAssessment: assessJupiterRoute(instructionReview, order),
          accountBindings: {
            slot: null,
            status: 'Unavailable',
            accounts: [],
            limitations: 'Synthetic unavailable account bindings.',
          },
          settlementEvidence: null,
          lookupObservation: null,
          tokensComplete: true,
          tokenChanges: [],
          inputAmountMatches: order.side === 'Buy' ? null : true,
          minimumOutputCovered: order.side === 'Buy' ? true : null,
          limitations:
            'Synthetic simulation only, no provider/financial qualification.',
        };
      },
      count: async () =>
        Promise.all(
          [
            'wallet_warmup_session_preparations',
            'wallet_warmup_session_action_bindings',
            'wallet_warmup_session_packets',
          ].map(
            async (t) =>
              (
                await f.db
                  .prepare(`SELECT count(*) AS n FROM ${t}`)
                  .first<{ n: number }>()
              )?.n,
          ),
        ),
    };
  } catch (error) {
    f.client.close();
    throw error;
  }
}
