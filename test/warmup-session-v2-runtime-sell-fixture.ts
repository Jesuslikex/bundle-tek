import { vi } from 'vitest';
import { warmupV2SavedBuyAttemptProviderFixture } from './warmup-session-v2-attempt-provider-fixture';
import { installWarmupRuntime } from './warmup-session-v2-runtime-fixture';
import { warmupRuntimeOrderFixture } from './warmup-runtime-order-fixture';
import { createWalletWarmupV2RuntimeProvider } from '../lib/wallet-warmup-session-v2-runtime-provider';
import { inspectWarmupSellInventory } from '../lib/warmup-sell-inventory';
import { appendWalletWarmupV2Journal } from '../lib/wallet-warmup-session-v2-journal';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import { TOKEN_PROGRAMS } from '../lib/wallet-holdings';
/** Native SQL and the real holdings/mint observer over a wholly synthetic HTTP transport. */
export async function warmupRuntimeSellFixture(
  options: {
    remainingRaw?: string;
    existing?: boolean;
    keepWrapped?: boolean;
  } = {},
) {
  const remaining = options.remainingRaw ?? '101';
  const f = await warmupV2SavedBuyAttemptProviderFixture(false, remaining);
  try {
    await installWarmupRuntime(f.db);
    let journal = f.v2Journal;
    const raw = await warmupRuntimeOrderFixture({
      side: 'Sell',
      mint: f.packets.mint,
      tokenRaw: BigInt(remaining),
      existing: options.existing,
      keepWrapped: options.keepWrapped,
    });
    const sales = await f.db
      .prepare(
        'SELECT document FROM warmup_sell_receipts WHERE owner_id=? AND buy_receipt_id=?',
      )
      .bind('owner', f.packets.buy.receiptId)
      .all<{ document: string }>();
    const receiptSlot = Math.max(
      f.packets.buyDocument.slot,
      ...sales.results.map((row) => Number(JSON.parse(row.document).slot)),
    );
    raw.state.slot = receiptSlot + 3;
    const state = {
      baseline: receiptSlot + 1,
      inventorySlot: receiptSlot + 1,
      mintSlot: receiptSlot + 2,
      raw: remaining,
      decimals: 6,
      frozen: false,
      program: TOKEN_PROGRAMS[0] as string,
      limited: false,
      returnedSlot: null as number | null,
      afterInventory: null as null | (() => void | Promise<void>),
      lastInventory: null as Awaited<
        ReturnType<typeof inspectWarmupSellInventory>
      > | null,
    };
    const source = raw.request.inventory!.accountExtensions[0].address;
    const inventoryFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (typeof init?.body !== 'string')
        throw Error('Synthetic JSON-RPC body required');
      const call = JSON.parse(init.body) as {
        id: number;
        method: string;
        params: unknown[];
      };
      if (state.limited)
        return Response.json(
          { error: { code: -32005, message: 'Synthetic rate limit' } },
          { status: 429 },
        );
      let result: unknown;
      if (call.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
      else if (call.method === 'getSlot') result = String(state.baseline);
      else if (call.method === 'getTokenAccountsByOwner') {
        const program = (call.params[1] as { programId: string }).programId;
        result = {
          context: { slot: state.inventorySlot },
          value:
            program === state.program
              ? [
                  {
                    pubkey: source,
                    account: {
                      owner: state.program,
                      executable: false,
                      data: {
                        space: 165,
                        parsed: {
                          type: 'account',
                          info: {
                            owner: raw.wallet,
                            mint: raw.mint,
                            state: state.frozen ? 'frozen' : 'initialized',
                            tokenAmount: {
                              amount: state.raw,
                              decimals: state.decimals,
                            },
                          },
                        },
                      },
                    },
                  },
                ]
              : [],
        };
      } else if (call.method === 'getAccountInfo')
        result = {
          context: { slot: state.mintSlot },
          value: {
            owner: state.program,
            executable: false,
            data: {
              space: 82,
              parsed: {
                type: 'mint',
                info: { decimals: state.decimals, isInitialized: true },
              },
            },
          },
        };
      else throw Error('Unexpected synthetic inventory method: ' + call.method);
      return Response.json({ jsonrpc: '2.0', id: call.id, result });
    });
    const factory = vi.fn(
      (
        db: D1Database,
        owner: string,
        key: string | undefined,
        lease: Parameters<typeof createWalletWarmupV2RuntimeProvider>[3],
      ) =>
        createWalletWarmupV2RuntimeProvider(db, owner, key, lease, {
          runtime: { ...raw.dependencies, now: () => Date.now() },
          inventory: async (
            wallet,
            mint,
            signal,
            amount,
            _fetcher,
            minimumSlot,
          ) => {
            const report = await inspectWarmupSellInventory(
              wallet,
              mint,
              signal,
              amount,
              inventoryFetch,
              minimumSlot,
            );
            state.lastInventory = structuredClone(report);
            await state.afterInventory?.();
            if (state.returnedSlot !== null) {
              report.minSlot = state.returnedSlot;
              report.mintSlot = state.returnedSlot;
            }
            return report;
          },
        }),
    );
    async function control(control: 'stop' | 'pause') {
      journal = await appendWalletWarmupV2Journal(
        f.db,
        'owner',
        {
          id: crypto.randomUUID(),
          journalId: journal.id,
          version: journal.version,
          headSha256: journal.headSha256,
          control,
        },
        new AbortController().signal,
      );
      return journal;
    }
    return {
      ...f,
      raw,
      latestReceiptSlot: receiptSlot,
      state,
      inventoryFetch,
      factory,
      control,
      get v2Journal() {
        return journal;
      },
      selection: () => ({
        id: crypto.randomUUID(),
        journalId: journal.id,
        version: journal.version,
        headSha256: journal.headSha256,
      }),
    };
  } catch (error) {
    f.client.close();
    throw error;
  }
}
