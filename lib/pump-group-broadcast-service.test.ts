import { afterEach, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import bs58 from 'bs58';
import { pumpGroupBroadcastFixture } from '../test/pump-group-broadcast-fixture';
import { preflightOwnedPumpCreate } from './owned-pump-preflight';
import { authorizeOwnedPumpGroupSigning } from './pump-group-runtime-service';
import {
  prepareOwnedPumpGroupBroadcast,
  registerOwnedPumpGroupTip,
  submitOwnedPumpGroupBroadcast,
  readOwnedPumpGroupBroadcast,
  type PumpGroupJitoRpc,
} from './pump-group-broadcast-service';
import { recoverOwnedPumpGroupBroadcast } from './pump-group-broadcast-recovery';
import { recoverOwnedPumpLaunchGroup } from './pump-launch-group-terminal-service';
import {
  buildPumpGroupTip,
  PUMP_GROUP_JITO_TIP_ACCOUNTS,
  type PumpGroupBroadcastConsent,
} from './pump-group-broadcast';
import { collectPumpProgramIdentities } from './pump-group-code-identity';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { parsePumpGroupView } from './pump-launch-group-client';
import { parsePumpGroupBroadcastState } from './pump-group-broadcast-client';
import * as broadcastSimulation from './pump-group-broadcast-simulation';
import { readFileSync } from 'node:fs';
import { openOwnedPumpTokenWorkspace } from './pump-launch-token-workspace-service';
import type { ImportedToken } from './token-import';
import { readOwnedPumpGroupRecordedCosts } from './pump-group-recorded-costs-service';
vi.mock('./owned-pump-preflight', async (original) => ({
  ...(await original<typeof import('./owned-pump-preflight')>()),
  preflightOwnedPumpCreate: vi.fn(),
}));
vi.mock('./pump-group-code-identity', async (original) => ({
  ...(await original<typeof import('./pump-group-code-identity')>()),
  collectPumpProgramIdentities: vi.fn(),
}));
const clients: Client[] = [],
  signal = () => new AbortController().signal;
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function setup() {
  const clock = new Date('2026-10-15T12:00:00.000Z');
  // CPU/SQL setup time must not age synthetic authorization evidence. Native
  // AbortSignal deadlines and all other timers remain real and enforced.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  const f = await pumpGroupBroadcastFixture(
    vi.mocked(preflightOwnedPumpCreate),
    clients,
    clock,
  );
  const preview = await f.preview();
  await authorizeOwnedPumpGroupSigning(
    f.db,
    'alice',
    f.saved.review.id,
    preview.id,
    f.consent,
    {
      approved: true,
      previewId: preview.id,
      identitySha256: preview.identitySha256,
      acknowledgeUpgradeableCode: true,
      acknowledgeNoSemanticAudit: true,
    },
    signal(),
    f.provider,
  );
  const group = await f.register();
  const tipRecipient = PUMP_GROUP_JITO_TIP_ACCOUNTS[0];
  const control = {
    badTip: false,
    tipErr: null as unknown,
    groupErr: null as unknown,
    chain: false,
    tipOnly: false,
    expiry: false,
    unknown: false,
    tipMissing: false,
    landed: null as number[] | null,
    packetErrs: null as unknown[] | null,
  };
  let tipBytes = '',
    tipSignature = '';
  const sends: unknown[][] = [],
    reads: { method: string; params: unknown[] }[] = [];
  const rpc: PumpLaunchRpc = async (method, params, sig) => {
    reads.push({ method, params });
    if (method === 'getTransaction') {
      if (!control.chain) return null;
      if (params[0] === tipSignature && control.tipMissing) return null;
      if (params[0] === tipSignature)
        return {
          slot: '250',
          transaction: [tipBytes, 'base64'],
          meta: {
            err: control.tipErr,
            fee: '5000',
            preBalances: ['100000000', '1000000', '1'],
            postBalances:
              control.tipErr === null
                ? ['99994000', '1001000', '1']
                : ['99995000', '1000000', '1'],
          },
        };
      if (control.tipOnly) return null;
      const packet = group.signedEvidence!.packets.find(
        (p) => p.signature === params[0],
      );
      if (!packet) throw new Error('Unexpected receipt signature');
      const index = group.signedEvidence!.packets.indexOf(packet);
      if (control.landed && !control.landed.includes(index)) return null;
      return {
        slot: '250',
        transaction: [packet.transaction, 'base64'],
        meta: {
          err: control.packetErrs
            ? control.packetErrs[index]
            : control.groupErr,
          fee: '5000',
        },
      };
    }
    if (method === 'getEpochInfo')
      return {
        absoluteSlot: (f.last + 2000n).toString(),
        blockHeight: (control.expiry ? f.last + 33n : f.last - 20n).toString(),
      };
    if (method === 'getAccountInfo' && control.expiry)
      return { context: { slot: (f.last + 2001n).toString() }, value: null };
    if (
      method === 'getFeeForMessage' &&
      Buffer.from(String(params[0]), 'base64')[0] === 1
    )
      return { context: { slot: '100' }, value: '5000' };
    const value = await f.provider(method, params, sig);
    if (method !== 'simulateBundle') return value;
    const req = params[0] as { encodedTransactions: string[] },
      cfg = params[1] as {
        postExecutionAccountsConfigs: { addresses: string[] }[];
      };
    if (req.encodedTransactions.length !== group.review.packets.length + 1)
      return value;
    const result = structuredClone(value) as {
      value: { transactionResults: Record<string, unknown>[] };
    };
    const last = result.value.transactionResults.at(-1)!;
    const payerIndex = cfg.postExecutionAccountsConfigs[
      group.review.packets.length - 1
    ].addresses.indexOf(group.review.input.create.payer);
    const payer = structuredClone(
      (last.postExecutionAccounts as Record<string, unknown>[])[payerIndex],
    );
    const receiver = {
      owner: '11111111111111111111111111111111',
      executable: false,
      lamports: '1000000',
      data: ['', 'base64'],
    };
    result.value.transactionResults.push({
      err: null,
      replacementBlockhash: null,
      preExecutionAccounts: [payer, receiver],
      postExecutionAccounts: [
        {
          ...payer,
          lamports: (BigInt(String(payer.lamports)) - 6000n).toString(),
        },
        { ...receiver, lamports: control.badTip ? '1001001' : '1001000' },
      ],
      fee: '5000',
      unitsConsumed: '150',
      loadedAccountsDataSize: '0',
    });
    return result;
  };
  const jito: PumpGroupJitoRpc = async (method, params) => {
    if (method === 'getTipAccounts') return [tipRecipient];
    if (method === 'getBundleStatuses') return { value: [null] };
    sends.push(params);
    if (control.unknown) throw new Error('Lost response');
    return 'a'.repeat(64);
  };
  const prepare = () =>
    prepareOwnedPumpGroupBroadcast(
      f.db,
      'alice',
      group.review.id,
      '1000',
      '5000',
      signal(),
      rpc,
      jito,
    );
  async function ready() {
    const prepared = (await prepare())!;
    const { message } = buildPumpGroupTip(prepared.review);
    const signed = new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        f.f.f.payerSigner.keyPair.privateKey,
        message,
      ),
    );
    tipBytes = Buffer.from(
      Uint8Array.from([1, ...signed, ...message]),
    ).toString('base64');
    tipSignature = bs58.encode(signed);
    const saved = await registerOwnedPumpGroupTip(
      f.db,
      'alice',
      group.review.id,
      prepared.review.id,
      prepared.review.sha256,
      tipBytes,
      signal(),
    );
    const consent: PumpGroupBroadcastConsent = {
      approved: true,
      reviewId: group.review.id,
      broadcastId: prepared.review.id,
      broadcastSha256: prepared.review.sha256,
      signedGroupSha256: prepared.review.signedGroupSha256,
      scope: 'one-attempt-jito-complete-group-and-tip',
      acknowledgeUncertainOutcome: true,
    };
    return { saved, consent };
  }
  return { ...f, group, rpc, jito, sends, reads, control, prepare, ready };
}
for (const changes of [0, 1])
  it(`refuses a failed attempt-write envelope with ${changes} changes before sending`, async () => {
    const f = await setup();
    const { consent } = await f.ready();
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith('INSERT INTO pump_group_broadcast_attempts')) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...values) => {
          const bound = bind(...values);
          vi.spyOn(bound, 'run').mockResolvedValue({
            success: false,
            meta: { changes },
          } as never);
          return bound;
        };
      }
      return statement;
    });
    await expect(
      submitOwnedPumpGroupBroadcast(
        f.db,
        'alice',
        f.group.review.id,
        consent,
        signal(),
        f.rpc,
        f.jito,
      ),
    ).rejects.toThrow();
    expect(f.sends).toHaveLength(0);
  }, 120000);
it('projects owner-only saved launch costs through real SQL and receipt parsers without a write or provider read', async () => {
  const f = await setup();
  await expect(
    readOwnedPumpGroupRecordedCosts(f.db, 'alice', f.group.review.id, signal()),
  ).rejects.toThrow('no closed');
  await f.ready();
  f.control.chain = true;
  await recoverOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    signal(),
    f.rpc,
    f.jito,
  );
  const reads = f.reads.length,
    sends = f.sends.length;
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => {
      throw Error('No provider allowed in saved costs');
    });
  const readonlyDb = {
    prepare(sql: string) {
      expect(sql.trim()).toMatch(/^SELECT\b/i);
      return f.db.prepare(sql);
    },
  } as unknown as D1Database;
  const report = await readOwnedPumpGroupRecordedCosts(
    readonlyDb,
    'alice',
    f.group.review.id,
    signal(),
  );
  expect(report).toMatchObject({
    reviewId: f.group.review.id,
    mint: f.group.review.input.create.mint,
    tipLamports: '1000',
    tipNetworkFeeLamports: '5000',
    groupNetworkFeeLamports: String(f.group.review.packets.length * 5000),
    knownTotalLamports: String(f.group.review.packets.length * 5000 + 6000),
    feeAndTipCoverageComplete: true,
    signingAllowed: false,
    executionAllowed: false,
    reservationsChanged: false,
    economicSettlementVerified: false,
  });
  expect(JSON.stringify(report)).not.toContain('signature');
  expect(JSON.stringify(report)).not.toContain('transaction');
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(f.reads).toHaveLength(reads);
  expect(f.sends).toHaveLength(sends);
  await expect(
    readOwnedPumpGroupRecordedCosts(
      readonlyDb,
      'bob',
      f.group.review.id,
      signal(),
    ),
  ).rejects.toThrow('not found');
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    readOwnedPumpGroupRecordedCosts(
      readonlyDb,
      'alice',
      f.group.review.id,
      aborted.signal,
    ),
  ).rejects.toThrow();
  // Deliberately corrupt a disposable fixture after removing its immutability guard.
  await f.client.execute('DROP TRIGGER pump_group_observation_no_update');
  await f.client.execute({
    sql: 'UPDATE pump_group_observations SET context_sha256=? WHERE owner_id=? AND review_id=?',
    args: ['f'.repeat(64), 'alice', f.group.review.id],
  });
  await expect(
    readOwnedPumpGroupRecordedCosts(
      readonlyDb,
      'alice',
      f.group.review.id,
      signal(),
    ),
  ).rejects.toThrow('exact retained launch observation');
}, 120000);

it('reviews additional costs, retains the exact tip, sends the fully revalidated vector once and finalizes from exact chain evidence', async () => {
  const f = await setup(),
    { saved, consent } = await f.ready();
  expect(saved?.attempted).toBe(false);
  expect(saved?.tip).not.toBeNull();
  await f.client.execute({
    sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
    args: [
      'alice',
      saved!.review.recipient,
      'warmup',
      'foreign-wallet-fixture',
      'approved',
    ],
  });
  await expect(
    f.client.execute({
      sql: 'UPDATE solana_execution_reservations SET wallet_address=? WHERE intent_id=?',
      args: [f.group.review.input.create.payer, 'foreign-wallet-fixture'],
    }),
  ).rejects.toThrow('reserved for complete group');
  await expect(
    f.client.execute({
      sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
      args: [
        'alice',
        f.group.review.input.create.payer,
        'warmup',
        'tip-cost-conflict',
        'approved',
      ],
    }),
  ).rejects.toThrow('reserved for complete group');
  const resultBeforeRecovery = await submitOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    consent,
    signal(),
    f.rpc,
    f.jito,
  );
  expect(resultBeforeRecovery?.attempted).toBe(true);
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0]).toEqual([
    [...saved!.review.transactions, saved!.tip!.transaction],
    { encoding: 'base64' },
  ]);
  expect(f.reads.some((r) => r.method === 'sendTransaction')).toBe(false);
  expect(
    f.reads
      .filter((r) => r.method === 'simulateBundle')
      .some(
        (r) =>
          (r.params[1] as { skipSigVerify: boolean }).skipSigVerify === false,
      ),
  ).toBe(true);
  f.control.chain = true;
  const result = await recoverOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    signal(),
    f.rpc,
    f.jito,
  );
  expect(result.group.state).toBe('finalized');
  expect(result.broadcast?.reservationsReleased).toBe(true);
  const view = await parsePumpGroupView(result.group, f.group.review.projectId);
  expect(
    (await parsePumpGroupBroadcastState(result.broadcast, view))?.recovery
      ?.state,
  ).toBe('finalized');
  expect(view.receipt).toMatchObject({
    economicSettlementVerified: false,
    completeLaunch: false,
    atomicity: 'jito-transport-requested-not-proven',
  });
  await expect(
    f.client.execute('DELETE FROM pump_group_broadcast_attempts'),
  ).rejects.toThrow('retained');
  await f.client.execute({
    sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
    args: [
      'alice',
      f.group.review.input.create.payer,
      'warmup',
      'released-after-tip-finality',
      'approved',
    ],
  });
  for (const sql of readFileSync(
    'drizzle/0024_imported_token_projects.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await f.client.execute(sql);
  const token: ImportedToken = {
    chain: 'Solana',
    address: view.review.input.create.mint,
    name: 'Created token',
    symbol: 'CREATED',
    decimals: 6,
    totalSupplyRaw: '1000000000000000',
    metadataUri: view.review.input.create.uri,
    observedAt: new Date().toISOString(),
    source: 'https://controlled-fixture.example',
    contextSlot: 250,
    tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    metadataKind: 'Token-2022',
  };
  const inspect = vi.fn(async () => structuredClone(token));
  await expect(
    openOwnedPumpTokenWorkspace(f.db, 'bob', view.review.id, signal(), inspect),
  ).rejects.toThrow('not found');
  expect(inspect).not.toHaveBeenCalled();
  await expect(
    openOwnedPumpTokenWorkspace(
      f.db,
      'alice',
      view.review.id,
      signal(),
      async () => ({ ...token, contextSlot: 249 }),
    ),
  ).rejects.toThrow('caught up');
  await expect(
    openOwnedPumpTokenWorkspace(
      f.db,
      'alice',
      view.review.id,
      signal(),
      async () => ({ ...token, source: `https://${'a'.repeat(254)}.example` }),
    ),
  ).rejects.toThrow('Token workspace response differs');
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM imported_token_projects',
      )
    ).rows[0].n,
  ).toBe(0);
  await f.client.execute(
    "CREATE TRIGGER test_workspace_history_failure BEFORE INSERT ON imported_token_project_events BEGIN SELECT RAISE(ABORT,'Controlled workspace history failure'); END;",
  );
  await expect(
    openOwnedPumpTokenWorkspace(
      f.db,
      'alice',
      view.review.id,
      signal(),
      inspect,
    ),
  ).rejects.toThrow('history failure');
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM imported_token_projects',
      )
    ).rows[0].n,
  ).toBe(0);
  await f.client.execute('DROP TRIGGER test_workspace_history_failure');
  await f.client.batch(
    Array.from({ length: 100 }, (_, i) => ({
      sql: "INSERT INTO imported_token_projects(owner_id,id,chain,address,document,mutation_id,updated_at) VALUES('alice',?,'Solana',?,'{}','capacity',?)",
      args: ['capacity-' + i, 'capacity-' + i, token.observedAt],
    })),
    'write',
  );
  await expect(
    openOwnedPumpTokenWorkspace(
      f.db,
      'alice',
      view.review.id,
      signal(),
      inspect,
    ),
  ).rejects.toThrow('100-project limit');
  await f.client.execute(
    "DELETE FROM imported_token_projects WHERE mutation_id='capacity'",
  );
  const workspaces = await Promise.all(
    [1, 2].map(() =>
      openOwnedPumpTokenWorkspace(
        f.db,
        'alice',
        view.review.id,
        signal(),
        inspect,
      ),
    ),
  );
  expect(new Set(workspaces.map((w) => w.project.id)).size).toBe(1);
  expect(workspaces[0].project.id).not.toBe(view.review.id);
  expect(workspaces.filter((w) => w.created)).toHaveLength(1);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM imported_token_project_events',
      )
    ).rows[0].n,
  ).toBe(1);
  expect(workspaces[0]).toMatchObject({
    executionAllowed: false,
    signingAllowed: false,
    reservationsChanged: false,
  });
  const project = workspaces[0].project;
  const settings = {
    side: 'Sell',
    amount: '10',
    wallet: f.group.review.input.create.payer,
    walletRevision: 1,
  };
  await f.client.execute({
    sql: 'UPDATE imported_token_projects SET revision=2,archived=1,document=? WHERE owner_id=? AND id=?',
    args: [
      JSON.stringify({ ...project.document, tradeSettings: settings }),
      'alice',
      project.id,
    ],
  });
  inspect.mockClear();
  const reused = await openOwnedPumpTokenWorkspace(
    f.db,
    'alice',
    view.review.id,
    signal(),
    inspect,
  );
  expect(reused).toMatchObject({
    created: false,
    project: {
      id: project.id,
      archived: true,
      revision: 2,
      document: { tradeSettings: settings },
    },
  });
  expect(inspect).not.toHaveBeenCalled();
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM imported_token_project_events',
      )
    ).rows[0].n,
  ).toBe(1);
}, 120000);
it('consumes exactly one database attempt when two requests race after validated simulation', async () => {
  const f = await setup(),
    { saved, consent } = await f.ready();
  // Isolate the atomic SQL race from CPU-heavy repeated replay. The test above exercises the real full replay path.
  vi.spyOn(
    broadcastSimulation,
    'simulateOwnedPumpGroupBroadcast',
  ).mockResolvedValue({
    format: 'pump-group-jito-simulation-v1',
    bankSlot: 100,
    tipFeeRaw: '5000',
    launchSimulationSha256: 'b'.repeat(64),
    replaySha256: 'c'.repeat(64),
    expiresAt: saved!.review.expiresAt,
    executionAllowed: false,
  });
  const results = await Promise.all(
    [1, 2].map(() =>
      submitOwnedPumpGroupBroadcast(
        f.db,
        'alice',
        f.group.review.id,
        consent,
        signal(),
        f.rpc,
        f.jito,
      ),
    ),
  );
  expect(results.every((r) => r?.attempted)).toBe(true);
  expect(f.sends).toHaveLength(1);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM pump_group_broadcast_attempts',
      )
    ).rows[0].n,
  ).toBe(1);
}, 120000);
it('never resends an uncertain result and keeps tip-only or incomplete outcomes reserved', async () => {
  const f = await setup(),
    { consent } = await f.ready();
  f.control.unknown = true;
  const result = await submitOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    consent,
    signal(),
    f.rpc,
    f.jito,
  );
  expect(result?.result?.outcome).toBe('unknown');
  await submitOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    consent,
    signal(),
    f.rpc,
    f.jito,
  );
  expect(f.sends).toHaveLength(1);
  f.control.chain = true;
  f.control.tipOnly = true;
  const recovered = await recoverOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    signal(),
    f.rpc,
    f.jito,
  );
  expect(recovered.broadcast?.recovery?.state).toBe('partial');
  expect(recovered.broadcast?.reservationsReleased).toBe(false);
  expect(recovered.group.state).toBe('signed');
  await expect(
    recoverOwnedPumpLaunchGroup(
      f.db,
      'alice',
      f.group.review.id,
      signal(),
      f.rpc,
    ),
  ).rejects.toThrow();
  expect(f.sends).toHaveLength(1);
}, 120000);
it('refuses changed code or explicit broadcast consent and never consumes an attempt', async () => {
  const f = await setup(),
    { consent } = await f.ready();
  await expect(
    submitOwnedPumpGroupBroadcast(
      f.db,
      'alice',
      f.group.review.id,
      { ...consent, broadcastSha256: 'f'.repeat(64) },
      signal(),
      f.rpc,
      f.jito,
    ),
  ).rejects.toThrow('one-attempt');
  const collect = vi.mocked(collectPumpProgramIdentities),
    original = collect.getMockImplementation()!;
  collect.mockImplementation(async (...args) => {
    const result = await original(...args);
    result.programs[0].codeSha256 = 'f'.repeat(64);
    return result;
  });
  await expect(
    submitOwnedPumpGroupBroadcast(
      f.db,
      'alice',
      f.group.review.id,
      consent,
      signal(),
      f.rpc,
      f.jito,
    ),
  ).rejects.toThrow('program bytes');
  expect(f.sends).toHaveLength(0);
  expect(
    (await readOwnedPumpGroupBroadcast(f.db, 'alice', f.group.review.id))
      ?.attempted,
  ).toBe(false);
}, 120000);
it('closes only linked expired-unobserved launch and tip lifetimes and preserves unresolved cost evidence', async () => {
  const f = await setup();
  // This case tests real expiry observations and SQL closure, not repeated replay.
  // The first case exercises the complete replay path. Keep that boundary controlled
  // here so CPU contention cannot expire the review before recovery even starts.
  vi.spyOn(
    broadcastSimulation,
    'simulateOwnedPumpGroupBroadcast',
  ).mockResolvedValue({
    format: 'pump-group-jito-simulation-v1',
    bankSlot: 100,
    tipFeeRaw: '5000',
    launchSimulationSha256: 'b'.repeat(64),
    replaySha256: 'c'.repeat(64),
    expiresAt: f.group.review.expiresAt,
    executionAllowed: false,
  });
  await f.ready();
  f.control.expiry = true;
  const result = await recoverOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    signal(),
    f.rpc,
    f.jito,
  );
  expect(result.group.state).toBe('cancelled');
  expect(result.broadcast?.reservationsReleased).toBe(true);
  expect(result.broadcast?.recovery?.tip.tipDebitRaw).toBeNull();
  expect(result.group.receipt).toMatchObject({
    networkFeeUnresolved: true,
    completeLaunch: false,
  });
  expect(f.sends).toHaveLength(0);
}, 120000);
it('rejects a tip credit mismatch during the full sequential replay and leaves the original group reserved', async () => {
  const f = await setup();
  f.control.badTip = true;
  await expect(f.prepare()).rejects.toThrow('recipient credit');
  expect(f.sends).toHaveLength(0);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM pump_group_broadcast_reviews',
      )
    ).rows[0].n,
  ).toBe(0);
}, 120000);
it('closes exact all-finalized failures only when tip and every group fee are resolved', async () => {
  const f = await setup();
  await f.ready();
  f.control.chain = true;
  f.control.groupErr = { InstructionError: [0, 'Custom'] };
  f.control.tipErr = { InstructionError: [0, 'Custom'] };
  const result = await recoverOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    signal(),
    f.rpc,
    f.jito,
  );
  expect(result.group.state).toBe('failed');
  expect(result.broadcast?.reservationsReleased).toBe(true);
  expect(result.group.receipt).toMatchObject({
    networkFeeUnresolved: false,
    tipDebitRaw: '0',
    tipNetworkFeeRaw: '5000',
  });
  expect(
    (
      await parsePumpGroupBroadcastState(
        result.broadcast,
        await parsePumpGroupView(result.group, f.group.review.projectId),
      )
    )?.recovery?.state,
  ).toBe('failed');
  expect(f.sends).toHaveLength(0);
  expect(
    await readOwnedPumpGroupRecordedCosts(
      f.db,
      'alice',
      f.group.review.id,
      signal(),
    ),
  ).toMatchObject({
    outcome: 'failed',
    tipLamports: '0',
    tipNetworkFeeLamports: '5000',
    feeAndTipCoverageComplete: true,
    knownTotalLamports: String((f.group.review.packets.length + 1) * 5000),
    economicSettlementVerified: false,
  });
}, 120000);
it('rejects mismatched closure kind or fee totals in SQL and keeps reservations until a valid retry', async () => {
  const f = await setup();
  await f.ready();
  f.control.expiry = true;
  for (const mutation of ['kind', 'fees']) {
    const poisonedDb = new Proxy(f.db, {
      get(target, property) {
        if (property !== 'prepare') {
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith('INSERT INTO pump_group_broadcast_closures'))
            return statement;
          return new Proxy(statement, {
            get(s, key) {
              if (key !== 'bind') {
                const value = Reflect.get(s, key);
                return typeof value === 'function' ? value.bind(s) : value;
              }
              return (...values: unknown[]) => {
                const receipt = JSON.parse(String(values[3])) as Record<
                  string,
                  unknown
                >;
                if (mutation === 'kind') receipt.kind = 'finalized';
                else receipt.knownNetworkFeeRaw = '999';
                values[3] = JSON.stringify(receipt);
                return s.bind(...values);
              };
            },
          });
        };
      },
    });
    await expect(
      recoverOwnedPumpGroupBroadcast(
        poisonedDb,
        'alice',
        f.group.review.id,
        signal(),
        f.rpc,
        f.jito,
      ),
    ).rejects.toThrow('proof');
    expect(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pump_group_broadcast_closures',
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await readOwnedPumpGroupBroadcast(f.db, 'alice', f.group.review.id))
        ?.reservationsReleased,
    ).toBe(false);
  }
  const result = await recoverOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    signal(),
    f.rpc,
    f.jito,
  );
  expect(result.broadcast?.reservationsReleased).toBe(true);
  expect(result.group.state).toBe('cancelled');
  expect(f.sends).toHaveLength(0);
}, 120000);

// Controlled simulation boundary, as in the expiry case above: these cases test
// recovery evidence and SQL closure, not the heavy sequential replay.
async function settledSetup() {
  const f = await setup();
  vi.spyOn(
    broadcastSimulation,
    'simulateOwnedPumpGroupBroadcast',
  ).mockResolvedValue({
    format: 'pump-group-jito-simulation-v1',
    bankSlot: 100,
    tipFeeRaw: '5000',
    launchSimulationSha256: 'b'.repeat(64),
    replaySha256: 'c'.repeat(64),
    expiresAt: f.group.review.expiresAt,
    executionAllowed: false,
  });
  const { consent } = await f.ready();
  await submitOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    consent,
    signal(),
    f.rpc,
    f.jito,
  );
  f.control.chain = true;
  return f;
}
const recover = (f: Awaited<ReturnType<typeof setup>>, db: D1Database = f.db) =>
  recoverOwnedPumpGroupBroadcast(
    db,
    'alice',
    f.group.review.id,
    signal(),
    f.rpc,
    f.jito,
  );
it('holds a partial landing until expiry, then settles it and releases reservations', async () => {
  const f = await settledSetup();
  f.control.landed = [0];
  f.control.tipMissing = true;
  const held = await recover(f);
  expect(held.broadcast?.recovery?.state).toBe('partial');
  expect(held.broadcast?.reservationsReleased).toBe(false);
  expect(held.group.state).toBe('signed');
  f.control.expiry = true;
  const result = await recover(f);
  const count = f.group.review.packets.length;
  expect(result.broadcast?.recovery?.state).toBe('partial-final');
  expect(result.broadcast?.recovery?.expiry?.pastExpiryMargin).toBe(true);
  expect(result.broadcast?.reservationsReleased).toBe(true);
  expect(result.group.state).toBe(count === 1 ? 'finalized' : 'failed');
  expect(result.group.receipt).toMatchObject({
    kind: 'partial',
    packetCount: count,
    landedPacketCount: 1,
    succeededPacketCount: 1,
    groupNetworkFeeRaw: '5000',
    tipNetworkFeeRaw: null,
    knownNetworkFeeRaw: '5000',
    networkFeeUnresolved: false,
    reservationsReleased: true,
    completeLaunch: false,
  });
  const view = await parsePumpGroupView(result.group, f.group.review.projectId);
  expect(
    (await parsePumpGroupBroadcastState(result.broadcast, view))?.recovery
      ?.state,
  ).toBe('partial-final');
  expect(f.sends).toHaveLength(1);
}, 120000);
it('settles a tip that landed alone after the launch packets expired unobserved', async () => {
  const f = await settledSetup();
  f.control.tipOnly = true;
  f.control.expiry = true;
  const result = await recover(f);
  expect(result.broadcast?.recovery?.state).toBe('partial-final');
  expect(result.group.state).toBe('failed');
  expect(result.group.receipt).toMatchObject({
    kind: 'partial',
    landedPacketCount: 0,
    succeededPacketCount: 0,
    tipDebitRaw: '1000',
    tipNetworkFeeRaw: '5000',
    knownNetworkFeeRaw: '5000',
    networkFeeUnresolved: false,
  });
  expect(result.broadcast?.reservationsReleased).toBe(true);
  expect(
    await readOwnedPumpGroupRecordedCosts(
      f.db,
      'alice',
      f.group.review.id,
      signal(),
    ),
  ).toMatchObject({
    outcome: 'partial',
    groupNetworkFeeLamports: '0',
    tipNetworkFeeLamports: '5000',
    tipLamports: '1000',
    knownTotalLamports: '6000',
    feeAndTipCoverageComplete: false,
  });
}, 120000);
it('settles an all-finalized mixed outcome immediately without an expiry read for packets', async () => {
  const f = await settledSetup();
  const count = f.group.review.packets.length;
  expect(count).toBeGreaterThan(1);
  f.control.packetErrs = f.group.review.packets.map((_, i) =>
    i === 0 ? null : { InstructionError: [0, 'Custom'] },
  );
  const result = await recover(f);
  expect(result.broadcast?.recovery?.state).toBe('partial-final');
  expect(result.group.state).toBe('failed');
  expect(result.group.receipt).toMatchObject({
    kind: 'partial',
    landedPacketCount: count,
    succeededPacketCount: 1,
    knownNetworkFeeRaw: (5000n * BigInt(count) + 5000n).toString(),
  });
}, 120000);
it('keeps a still-pending tip held even when every launch packet finalized', async () => {
  const f = await settledSetup();
  f.control.packetErrs = f.group.review.packets.map(() => null);
  f.control.tipMissing = true;
  const result = await recover(f);
  expect(result.broadcast?.recovery?.state).toBe('partial');
  expect(result.broadcast?.recovery?.expiry?.pastExpiryMargin).toBe(false);
  expect(result.broadcast?.reservationsReleased).toBe(false);
  expect(result.group.state).toBe('signed');
}, 120000);
it('rejects forged partial counts or states in SQL and keeps reservations until a valid retry', async () => {
  const f = await settledSetup();
  f.control.landed = [0];
  f.control.tipMissing = true;
  f.control.expiry = true;
  for (const mutation of ['succeeded', 'landed', 'state']) {
    const poisonedDb = new Proxy(f.db, {
      get(target, property) {
        if (property !== 'prepare') {
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith('INSERT INTO pump_group_broadcast_closures'))
            return statement;
          return new Proxy(statement, {
            get(s, key) {
              if (key !== 'bind') {
                const value = Reflect.get(s, key);
                return typeof value === 'function' ? value.bind(s) : value;
              }
              return (...values: unknown[]) => {
                const receipt = JSON.parse(String(values[3])) as Record<
                  string,
                  unknown
                >;
                if (mutation === 'succeeded') receipt.succeededPacketCount = 0;
                else if (mutation === 'landed') receipt.landedPacketCount = 2;
                else {
                  values[4] = values[4] === 'failed' ? 'finalized' : 'failed';
                }
                values[3] = JSON.stringify(receipt);
                return s.bind(...values);
              };
            },
          });
        };
      },
    });
    await expect(recover(f, poisonedDb)).rejects.toThrow('proof');
    expect(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pump_group_broadcast_closures',
        )
      ).rows[0].n,
    ).toBe(0);
  }
  const result = await recover(f);
  expect(result.broadcast?.reservationsReleased).toBe(true);
}, 120000);
