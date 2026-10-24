import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import { jitoRawResponseFixture } from './jito-raw-response-fixture';
import { jitoDatabase } from './jito-sqlite';
import { tradeSessionTerms } from '../lib/imported-trade-session';
import { unsignedPreparationSummary } from '../lib/imported-swap-preparation-history';
import { bundleFingerprint } from '../lib/jito-bundle';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
const databases: ReturnType<typeof jitoDatabase>[] = [];
export function closeOwnedJitoSequentialFixtures() {
  for (const d of databases.splice(0)) d.sqlite.close();
}
export async function ownedJitoSequentialFixture(
  options: {
    side?: 'Buy' | 'Sell';
    lookup?: boolean;
    token2022?: boolean;
    wallets?: number;
    savedFeeSlot?: number;
  } = {},
) {
  const f = await jitoRawResponseFixture(options),
    manifest = f.fixture.manifest;
  const first = f.fixture.observations[0].order;
  const mint = first.side === 'Buy' ? first.outputMint : first.inputMint;
  const terms = tradeSessionTerms(
    {
      projectId: manifest.projectId,
      projectRevision: 1,
      side: first.side,
      entries: manifest.swaps.map((r) => ({
        wallet: r.wallet,
        walletRevision: 1,
        amount: '0.001',
      })),
    },
    { chain: 'Solana', address: mint, decimals: 6 },
  );
  const document = JSON.stringify(terms),
    termsSha256 = createHash('sha256').update(document).digest('hex');
  for (const [i, r] of manifest.swaps.entries())
    r.session = {
      format: 'trade-session-entry-v1',
      sessionId: manifest.sessionId,
      sessionRevision: 1,
      entry: i + 1,
      unitsRaw: r.inputRaw,
      termsSha256,
    };
  manifest.sha256 = await bundleFingerprint(
    (({ sha256: _digest, ...rest }) => rest)(manifest),
  );
  const d = jitoDatabase(manifest);
  databases.push(d);
  d.sqlite.exec(
    'ALTER TABLE imported_token_projects ADD COLUMN document TEXT; ALTER TABLE imported_trade_sessions ADD COLUMN created_at TEXT; ALTER TABLE imported_trade_sessions ADD COLUMN updated_at TEXT;',
  );
  d.sqlite
    .prepare('UPDATE imported_token_projects SET address=?,document=?')
    .run(mint, JSON.stringify({ token: { address: mint, decimals: 6 } }));
  d.sqlite
    .prepare(
      'UPDATE imported_trade_sessions SET document=?,created_at=?,updated_at=?',
    )
    .run(document, manifest.createdAt, manifest.createdAt);
  for (const [i, r] of manifest.swaps.entries()) {
    const summary = unsignedPreparationSummary(
      f.fixture.observations[i].order,
      f.fixture.observations[i].simulation,
    );
    if (options.savedFeeSlot !== undefined)
      summary.simulation.feeSlot = options.savedFeeSlot;
    d.sqlite
      .prepare('UPDATE imported_swap_preparations SET document=? WHERE id=?')
      .run(JSON.stringify({ ...summary, session: r.session }), r.preparationId);
  }
  d.attach();
  const calls: string[] = [],
    pace = vi.fn(async (_endpoint: string, _signal: AbortSignal) => {});
  let hook: ((method: string) => void | Promise<void>) | undefined;
  let feeStatus = 200,
    simulationStatus = 200,
    lookupDrift = false,
    simulationSeen = false;
  let supportSlot = 101n,
    feeSlot = 101n,
    supportAfterSlot = 101n;
  const fetcher: typeof fetch = async (_url, init) => {
    if (typeof init?.body !== 'string')
      throw Error('Expected synthetic string body');
    const request = JSON.parse(init.body) as
      | { id: string; method: string; params: unknown[] }
      | { id: string; method: string; params: unknown[] }[];
    const method = Array.isArray(request) ? 'fees' : request.method;
    calls.push(method);
    await hook?.(method);
    if (Array.isArray(request))
      return new Response(
        f.wire(
          request.map((r) => ({
            jsonrpc: '2.0',
            id: r.id,
            result: {
              context: { slot: feeSlot, apiVersion: '4.3.2' },
              value: 5000n,
            },
          })),
        ),
        { status: feeStatus },
      );
    if (method === 'getGenesisHash')
      return new Response(
        f.wire({
          jsonrpc: '2.0',
          id: request.id,
          result: SOLANA_MAINNET_GENESIS,
        }),
      );
    if (method === 'getMultipleAccounts') {
      const values = (request.params[0] as string[]).map((key) => {
        const source = f.fixture.lookupAccounts.find(
          (a) => a.address === key,
        )?.account;
        if (!source) throw Error('Unexpected synthetic lookup');
        const data = [...source.data];
        if (lookupDrift && simulationSeen) {
          const bytes = Buffer.from(data[0], 'base64');
          bytes[56] ^= 1;
          data[0] = bytes.toString('base64');
        }
        return {
          ...source,
          data,
          lamports: BigInt(source.lamports),
          rentEpoch: (1n << 64n) - 1n,
          space: BigInt(Buffer.from(data[0], 'base64').length),
        };
      });
      return new Response(
        f.wire({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            context: { slot: simulationSeen ? supportAfterSlot : supportSlot },
            value: values,
          },
        }),
      );
    }
    if (method === 'simulateBundle') {
      simulationSeen = true;
      return new Response(f.wire({ ...f.envelope, id: request.id }), {
        status: simulationStatus,
      });
    }
    throw Error('Unexpected synthetic method');
  };
  const dependencies = { fetcher, pace };
  return {
    f,
    d,
    calls,
    pace,
    dependencies,
    input: { id: manifest.id, sha256: manifest.sha256 },
    setHook: (fn: typeof hook) => {
      hook = fn;
    },
    setStatus: (phase: 'fees' | 'simulation', status: number) => {
      if (phase === 'fees') feeStatus = status;
      else simulationStatus = status;
    },
    driftLookup: () => {
      lookupDrift = true;
    },
    setSlots: (before: bigint, fee: bigint, after = before) => {
      supportSlot = before;
      feeSlot = fee;
      supportAfterSlot = after;
      f.envelope.result.context.slot = fee;
    },
  };
}
