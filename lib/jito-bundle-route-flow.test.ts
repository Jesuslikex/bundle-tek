import { afterEach, expect, it, vi } from 'vitest';
// Native SQLite/synthetic signer route contracts, not production admission.
// The real gate's default false and pre-DB 409 are separately asserted.
vi.mock('@/lib/jito-cpmm-unsigned-review', async (original) => ({
  ...(await original<typeof import('@/lib/jito-cpmm-unsigned-review')>()),
  JITO_RUNTIME_SIGNING_ENABLED: true,
}));
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { jitoDatabase } from '../test/jito-sqlite';
import { submitJitoBundle } from './jito-bundle-server';
import { unsignedPreparationSummary } from './imported-swap-preparation-history';
import type { JitoBundleRecord } from './jito-bundle';
const control = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  simulation: null as unknown,
  statuses: null as unknown,
  receipt: null as unknown,
  recovered: null as unknown,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: 'owner' }),
}));
vi.mock('@/db', () => ({ getD1: () => control.db }));
// Provider-dependent replay and the separately tested swap settlement route are
// synthetic; HTTP admission, native SQL, signatures, Jito wire and closure are real.
vi.mock('./imported-trade-session-server', async (original) => ({
  ...(await original<object>()),
  currentTradeSession: async () => undefined,
}));
vi.mock('./imported-swap-simulation', async (original) => {
  const actual = await original<typeof import('./imported-swap-simulation')>();
  return {
    ...actual,
    simulateImportedSwap: (
      ...args: Parameters<typeof actual.simulateImportedSwap>
    ) =>
      control.simulation && args[2] === fetch
        ? Promise.resolve(control.simulation)
        : actual.simulateImportedSwap(...args),
  };
});
vi.mock('./native-withdrawal-server', async (original) => ({
  ...(await original<object>()),
  recheckNativeWithdrawal: async () => undefined,
}));
vi.mock('@/app/api/imported-projects/signing/route', () => ({
  POST: async () =>
    Response.json({ state: 'finalized', receipt: control.recovered }),
}));
vi.mock('./wallet-balances', async (original) => {
  const actual = await original<typeof import('./wallet-balances')>();
  return {
    ...actual,
    balanceRpc: async (...args: Parameters<typeof actual.balanceRpc>) => {
      if (args[4] !== fetch) return actual.balanceRpc(...args);
      const method = args[1];
      if (method === 'getGenesisHash') return actual.SOLANA_MAINNET_GENESIS;
      if (method === 'getBalance') return { value: '1000000000' };
      if (method === 'getSignatureStatuses') return control.statuses;
      if (method === 'getTransaction') return control.receipt;
      if (method === 'getBlockHeight') return '0';
      throw Error('Unexpected synthetic RPC ' + method);
    },
  };
});
import { GET, POST } from '@/app/api/imported-projects/jito-bundles/route';
import { JITO_OWNER_SCOPE_HEADER, jitoOwnerScope } from './jito-owner-scope';
const databases: ReturnType<typeof jitoDatabase>[] = [];
afterEach(() => {
  for (const d of databases.splice(0)) d.sqlite.close();
  vi.unstubAllGlobals();
});
for (const token2022 of [false, true])
  for (const unknown of [false, true])
    it(`composes saved HTTP review, exact signatures, one real Jito wire and read-only recovery (unknown=${unknown}, Token2022=${token2022})`, async () => {
      const f = await jitoBundleFixture(1, token2022),
        d = jitoDatabase(f.manifest, true, true);
      databases.push(d);
      control.db = d.db;
      d.sqlite.exec(
        'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
      );
      d.sqlite.prepare('UPDATE imported_swap_preparations SET document=?').run(
        JSON.stringify({
          ...unsignedPreparationSummary(f.swap.order, f.swap.simulation),
          session: f.review.session,
        }),
      );
      d.attach();
      const fresh = structuredClone(f.swap.simulation);
      if (token2022) {
        fresh.simulationSlot = 111;
        fresh.accountBindings.slot = 110;
        fresh.token2022Evidence!.slot = 110;
        fresh.token2022Evidence!.recheckSlot = 111;
      }
      control.simulation = fresh;
      control.statuses = { value: [null, null] };
      control.receipt = null;
      const packets = [f.swap.signed.transaction, f.tip.signed.transaction];
      const signatures = [f.swap.signed.signature, f.tip.signed.signature];
      const sends: unknown[] = [],
        calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, init) => {
          expect(url).toBe(
            'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
          );
          expect(init.redirect).toBe('error');
          const b = JSON.parse(init.body);
          calls.push(b.method);
          if (b.method === 'getTipAccounts')
            return Response.json({
              jsonrpc: '2.0',
              id: 1,
              result: [f.tip.recipient],
            });
          if (b.method === 'sendBundle') {
            sends.push(b.params);
            if (unknown) throw Error('Lost acknowledgement');
            return Response.json({
              jsonrpc: '2.0',
              id: 1,
              result: 'ab'.repeat(32),
            });
          }
          if (b.method === 'getBundleStatuses')
            return Response.json({
              jsonrpc: '2.0',
              id: 1,
              result: {
                value: [
                  {
                    bundle_id: 'ab'.repeat(32),
                    transactions: signatures,
                    slot: 300,
                    confirmation_status: 'finalized',
                    err: { Ok: null },
                  },
                ],
              },
            });
          throw Error('Unexpected transport ' + b.method);
        }),
      );
      const scope = await jitoOwnerScope('owner');
      const post = (body: object) =>
        POST(
          new Request('http://localhost/api/imported-projects/jito-bundles', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'http://localhost',
              'x-jito-protocol': '2',
              [JITO_OWNER_SCOPE_HEADER]: scope,
            },
            body: JSON.stringify(body),
          }),
        );
      const history = await GET(
        new Request(
          `http://localhost/api/imported-projects/jito-bundles?projectId=${f.manifest.projectId}&sessionId=${f.manifest.sessionId}`,
          {
            headers: {
              'x-jito-protocol': '2',
              [JITO_OWNER_SCOPE_HEADER]: scope,
            },
          },
        ),
      );
      expect(history.status).toBe(200);
      expect(
        ((await history.json()) as { bundles: JitoBundleRecord[] }).bundles[0]
          .state,
      ).toBe('reviewed');
      expect(calls).toEqual([]);
      const identity = {
        id: f.manifest.id,
        sha256: f.manifest.sha256,
        approved: true,
      };
      for (const [packet, transaction] of packets.entries()) {
        const attemptId = crypto.randomUUID();
        const begin = await post({
          action: 'begin-signing',
          ...identity,
          packet,
          attemptId,
        });
        expect(begin.status).toBe(200);
        expect(await begin.json()).toMatchObject({
          mayInvokeSigner: true,
          attempt: { state: 'unknown' },
        });
        expect(
          (
            await post({
              action: 'register',
              ...identity,
              packet,
              attemptId,
              transaction,
            })
          ).status,
        ).toBe(200);
      }
      expect(calls).toEqual([]);
      const result = await post({ action: 'submit', ...identity });
      expect(result.status).toBe(409);
      expect(sends).toHaveLength(0);
      // Only the synthetic legacy service fixture may create an old in-flight
      // record. The application HTTP boundary stays blocked in every mode.
      const prior = await submitJitoBundle(
        d.db,
        'owner',
        f.manifest.id,
        f.manifest.sha256,
        new AbortController().signal,
      );
      expect(prior.state).toBe(unknown ? 'submitting' : 'submitted');
      expect(sends).toEqual([[packets, { encoding: 'base64' }]]);
      d.sqlite.exec('DELETE FROM wallet_balance_gates');
      await post({ action: 'submit', ...identity });
      expect(sends).toHaveLength(1);
      if (!unknown) {
        control.statuses = {
          value: signatures.map(() => ({
            slot: '300',
            err: null,
            confirmationStatus: 'finalized',
          })),
        };
        control.receipt = { ...f.tip.receipt, slot: '300' };
        control.recovered = {
          projectId: f.manifest.projectId,
          preparationId: f.review.preparationId,
          document: {
            side: 'Buy',
            network: 'mainnet',
            commitment: 'finalized',
            signatureVerified: true,
            signature: signatures[0],
            wallet: f.review.wallet,
            preparationSha256: f.review.sha256,
            slot: 300,
            mint: f.review.outputMint,
          },
        };
      }
      d.sqlite.exec('DELETE FROM wallet_balance_gates');
      const recovered = await post({ action: 'recover', id: f.manifest.id });
      expect(recovered.status).toBe(200);
      const saved = ((await recovered.json()) as { bundle: JitoBundleRecord })
        .bundle;
      expect(saved.state).toBe(unknown ? 'submitting' : 'finalized');
      if (!unknown)
        expect(saved.finalization).toMatchObject({
          bundleSha256: f.manifest.sha256,
          signatures,
          slot: 300,
        });
      expect(sends).toHaveLength(1);
      expect(calls).not.toContain('sendTransaction');
    });
