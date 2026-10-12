import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletAddress } from '@/lib/wallet-workspace';
import {
  observeWalletHoldings,
  HoldingsReadError,
  type HoldingsSnapshot,
} from '@/lib/wallet-holdings';
import { importedWalletInventory } from '@/lib/imported-wallet-inventory';
import { UUID } from '@/lib/wallet-operation';
import { createHoldingsGroupFetcher } from '@/lib/holdings-group-fetcher';
import {
  observeWalletMintHoldings,
  type MintHoldingsSnapshot,
} from '@/lib/wallet-mint-holdings';
import { importedMintInventory } from '@/lib/imported-mint-inventory';
import { getSolanaIndexerRpcEndpoint } from '@/lib/solana-rpc';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to refresh session inventory.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let input: {
    id: string;
    revision: number;
    wallets: Array<{ address: string; revision: number }>;
    scope?: 'mint';
  };
  try {
    const text = await request.text();
    if (text.length > 5000)
      return json({ error: 'Session refresh request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      !['id,revision,wallets', 'id,revision,scope,wallets'].includes(
        Object.keys(input).sort().join(','),
      ) ||
      ('scope' in input && input.scope !== 'mint') ||
      !UUID.test(input.id) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      !Array.isArray(input.wallets) ||
      !input.wallets.length ||
      input.wallets.length > 25
    )
      throw new Error();
    const seen = new Set<string>();
    for (const w of input.wallets) {
      if (
        !w ||
        Object.keys(w).sort().join(',') !== 'address,revision' ||
        walletAddress(w.address, 'Solana') !== w.address ||
        seen.has(w.address) ||
        !Number.isSafeInteger(w.revision) ||
        w.revision < 1
      )
        throw new Error();
      seen.add(w.address);
    }
  } catch {
    return json(
      {
        error:
          'Choose a current project and 1 to 25 distinct wallet revisions.',
      },
      400,
    );
  }
  try {
    const db = getD1(),
      project = await db
        .prepare(
          "SELECT document FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND chain='Solana' AND archived=0",
        )
        .bind(user.userId, input.id, input.revision)
        .first<{ document: string }>();
    if (!project)
      return json({ error: 'Project changed or is unavailable.' }, 409);
    const token = JSON.parse(project.document).token as {
      address: string;
      decimals: number;
    };
    walletAddress(token.address, 'Solana');
    const rows = await db
      .prepare(
        "SELECT address,revision FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address IN (SELECT json_extract(value,'$.address') FROM json_each(?))",
      )
      .bind(user.userId, JSON.stringify(input.wallets))
      .all<{ address: string; revision: number }>();
    if (
      rows.results.length !== input.wallets.length ||
      input.wallets.some(
        (w) =>
          !rows.results.some(
            (r) => r.address === w.address && r.revision === w.revision,
          ),
      )
    )
      return json(
        { error: 'Selected wallets changed or are unavailable.' },
        409,
      );
    const now = Date.now(),
      gate = await db
        .prepare(
          'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
        )
        .bind(user.userId, now + 45000, now)
        .run();
    if (!gate.meta.changes)
      return json(
        {
          error:
            'Wait before another holdings refresh. Group refreshes reserve 45 seconds.',
        },
        429,
      );
    const controller = new AbortController(),
      signal = AbortSignal.any([
        request.signal,
        controller.signal,
        AbortSignal.timeout(40000),
      ]);
    const snapshots: Array<HoldingsSnapshot | MintHoldingsSnapshot> = [];
    snapshots.length = input.wallets.length;
    const groupFetcher = createHoldingsGroupFetcher();
    let cursor = 0,
      failed = false;
    let failureCode = 'HOLDINGS_READ_FAILED',
      failureWallet: string | undefined;
    await Promise.all(
      Array.from({ length: Math.min(3, input.wallets.length) }, async () => {
        while (!signal.aborted) {
          const index = cursor++;
          if (index >= input.wallets.length) return;
          try {
            snapshots[index] =
              input.scope === 'mint'
                ? await observeWalletMintHoldings(
                    input.wallets[index].address,
                    token.address,
                    token.decimals,
                    signal,
                    fetch,
                    new URL(getSolanaIndexerRpcEndpoint()).hostname ===
                      'mainnet.helius-rpc.com'
                      ? { pagination: 'helius-v2' }
                      : {},
                  )
                : await observeWalletHoldings(
                    input.wallets[index].address,
                    signal,
                    groupFetcher,
                  );
          } catch (error) {
            if (!failed) {
              failureCode =
                error instanceof HoldingsReadError
                  ? (error.code ?? 'HOLDINGS_READ_FAILED')
                  : 'INVALID_HOLDINGS';
              failureWallet = input.wallets[index].address;
              failed = true;
            }
            controller.abort();
            return;
          }
        }
      }),
    );
    if (
      failed ||
      signal.aborted ||
      snapshots.filter(Boolean).length !== input.wallets.length
    )
      return json(
        {
          code: failureCode,
          wallet: failureWallet,
          error: ['BATCH_TOO_LARGE', 'RESULT_TOO_LARGE'].includes(failureCode)
            ? 'A selected wallet exceeds the supported holdings response limit. Previous observations are retained; no partial group was saved.'
            : 'Group holdings refresh failed. Previous observations are retained; no partial group was saved.',
        },
        502,
      );
    const items = snapshots.map((s, index) =>
      (input.scope === 'mint'
        ? importedMintInventory
        : importedWalletInventory)(
        s as HoldingsSnapshot & MintHoldingsSnapshot,
        input.wallets[index].address,
        input.wallets[index].revision,
        token.address,
        token.decimals,
      ),
    );
    if (
      items.some(
        (i) =>
          !i.observation ||
          Date.now() - Date.parse(i.observation.observedAt) > 60000 ||
          Date.parse(i.observation.observedAt) > Date.now() + 5000,
      )
    )
      throw new Error();
    const data = JSON.stringify(
      snapshots.map((s, index) => ({
        address: s.address,
        revision: input.wallets[index].revision,
        document: JSON.stringify(s),
        minSlot: items[index].observation!.minSlot,
        maxSlot: items[index].observation!.maxSlot,
      })),
    );
    if (new TextEncoder().encode(data).length > 1048576)
      return json(
        {
          error:
            'Group holdings evidence exceeds the refresh size limit. Use smaller groups.',
        },
        413,
      );
    const fullSql = [
      `WITH incoming AS MATERIALIZED (SELECT json_extract(value,'$.address') address,json_extract(value,'$.revision') revision,json_extract(value,'$.document') document,json_extract(value,'$.minSlot') minSlot,json_extract(value,'$.maxSlot') maxSlot FROM json_each(?4)), admitted AS MATERIALIZED (SELECT CASE WHEN EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=?1 AND id=?2 AND revision=?3 AND chain='Solana' AND archived=0 AND document=?5) AND NOT EXISTS(SELECT 1 FROM incoming i LEFT JOIN workspace_wallets w ON w.owner_id=?1 AND w.chain='Solana' AND w.address=i.address WHERE w.address IS NULL OR w.archived!=0 OR w.revision!=i.revision) AND NOT EXISTS(SELECT 1 FROM incoming i JOIN wallet_holdings_snapshots s ON s.owner_id=?1 AND s.chain='Solana' AND s.address=i.address WHERE s.max_slot>i.minSlot) THEN 1 ELSE 0 END ok) INSERT INTO wallet_holdings_snapshots(owner_id,chain,address,document,max_slot) SELECT ?1,'Solana',address,document,maxSlot FROM incoming WHERE (SELECT ok FROM admitted)=1 ON CONFLICT(owner_id,chain,address) DO UPDATE SET document=excluded.document,max_slot=excluded.max_slot`,
    ][0];
    const sql =
      input.scope === 'mint'
        ? fullSql
            .replaceAll(
              'wallet_holdings_snapshots',
              'wallet_mint_holdings_snapshots',
            )
            .replace(
              'WHERE s.max_slot>i.minSlot',
              'WHERE s.mint=?6 AND s.max_slot>i.minSlot',
            )
            .replace(
              '(owner_id,chain,address,document,max_slot)',
              '(owner_id,chain,address,mint,document,max_slot)',
            )
            .replace(
              "SELECT ?1,'Solana',address,document,maxSlot",
              "SELECT ?1,'Solana',address,?6,document,maxSlot",
            )
            .replace(
              'ON CONFLICT(owner_id,chain,address)',
              'ON CONFLICT(owner_id,chain,address,mint)',
            )
        : fullSql;
    const statement = db.prepare(sql);
    const stored = await statement
      .bind(
        user.userId,
        input.id,
        input.revision,
        data,
        project.document,
        ...(input.scope === 'mint' ? [token.address] : []),
      )
      .run();
    if (stored.meta.changes !== input.wallets.length)
      return json(
        {
          error:
            'Project, wallet revisions or retained slots changed. No group observations were saved.',
        },
        409,
      );
    return json({
      id: input.id,
      revision: input.revision,
      mint: token.address,
      decimals: token.decimals,
      executionAllowed: false,
      items,
    });
  } catch {
    return json(
      {
        error:
          'Group holdings evidence or storage unavailable. Review saved inventory before retrying.',
      },
      503,
    );
  }
}
