import {
  previewOwnedPumpGroupRuntime,
  authorizeOwnedPumpGroupSigning,
} from './pump-group-runtime-service';
import { pumpAccountBytes, pumpRpcAccount } from './pump-launch-simulation';
import { pumpGroupProgramDataLink } from './pump-launch-group-deployments';
import { collectPumpProgramIdentities } from './pump-group-code-identity';
import { requirePumpSigningAuthorization } from './pump-group-runtime-authorization';
import { pumpHolderDigest } from './pump-holder-review';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Client } from '@libsql/client';
import { pumpOwnedGroupFixture } from '../test/pump-owned-group-fixture';
import { signSyntheticPumpGroup } from '../test/pump-group-synthetic-signatures';
import { preflightOwnedPumpCreate } from './owned-pump-preflight';
import {
  preparePumpLaunchGroupReview,
  approvePumpLaunchGroupReview,
  registerPumpLaunchGroupSignatures,
} from './pump-launch-group-review-service';
import { collectOwnedPumpGroupObservation } from './pump-launch-group-observation-service';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import type { PumpLaunchGroupConsent } from './pump-launch-group-review';
vi.mock('./owned-pump-preflight', async (original) => ({
  ...(await original<typeof import('./owned-pump-preflight')>()),
  preflightOwnedPumpCreate: vi.fn(),
}));
vi.mock('./pump-group-code-identity', async (original) => ({
  ...(await original<typeof import('./pump-group-code-identity')>()),
  collectPumpProgramIdentities: vi.fn(),
}));
const clients: Client[] = [];
const mocked = vi.mocked(preflightOwnedPumpCreate);
afterEach(() => {
  mocked.mockReset();
  for (const c of clients.splice(0)) c.close();
});
async function fixture(
  installed = true,
  approved = false,
  registered = false,
  terminalInstalled = true,
) {
  const f = await pumpOwnedGroupFixture(mocked, clients);
  await f.client.execute(
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT,PRIMARY KEY(owner_id,wallet_address))',
  );
  for (const file of [
    '0079_real_justice',
    '0081_pump_holder_reservations',
    '0082_pump_group_reviews',
    '0083_pump_group_approvals',
    '0084_pump_group_signatures',
    ...(installed ? ['0085_pump_group_observations'] : []),
    ...(terminalInstalled
      ? [
          '0086_pump_group_terminal_recovery',
          '0087_pump_group_runtime_authorization',
        ]
      : []),
  ])
    for (const sql of readFileSync(`drizzle/${file}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) await f.client.execute(sql);
  const signal = () => new AbortController().signal;
  const saved = await preparePumpLaunchGroupReview(
    f.db,
    'alice',
    f.terms,
    signal(),
    f.rpc,
  );
  const consent: PumpLaunchGroupConsent = {
    approved: true,
    reviewId: saved.review.id,
    manifestSha256: saved.review.manifestSha256,
    contextSha256: saved.review.contextSha256,
    simulationSha256: saved.review.simulationSha256,
    approvedScope: 'complete-create-developer-holder-packet-group',
    acknowledgeSimulationLimits: true,
  };
  if (approved)
    await approvePumpLaunchGroupReview(
      f.db,
      'alice',
      saved.review.id,
      consent,
      signal(),
      f.rpc,
    );
  const transactions = await signSyntheticPumpGroup(saved.review.packets, [
    f.f.f.payerSigner,
    f.f.f.mintSigner,
    ...f.holderSigners,
  ]);
  const register = () =>
    registerPumpLaunchGroupSignatures(
      f.db,
      'alice',
      saved.review.id,
      consent,
      transactions,
      signal(),
    );
  const signed = registered ? await register() : null;
  const calls: { method: string; params: unknown[] }[] = [];
  const last = BigInt(saved.review.input.create.lastValidBlockHeight);
  const state = {
    packets: transactions.map(() => null as unknown),
    height: last.toString(),
  };
  const rpc: PumpLaunchRpc = async (method, params, control) => {
    control.throwIfAborted();
    calls.push({ method, params });
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getEpochInfo')
      return {
        blockHeight: state.height,
        absoluteSlot: (last + 2000n).toString(),
      };
    if (method === 'getAccountInfo')
      return { context: { slot: (last + 2001n).toString() }, value: null };
    if (method === 'getTransaction') {
      const i = signed!.signedEvidence!.packets.findIndex(
        (p) => p.signature === params[0],
      );
      if (i < 0) throw new Error('Unexpected ID');
      return state.packets[i];
    }
    throw new Error('No other recovery methods permitted');
  };
  const collect = (
    provider = rpc,
    owner = 'alice',
    control = signal(),
    db = f.db,
  ) =>
    collectOwnedPumpGroupObservation(
      db,
      owner,
      saved.review.id,
      control,
      provider,
    );
  const rows = async () =>
    (await f.client.execute('SELECT * FROM pump_group_observations')).rows;
  return {
    ...f,
    preparationRpc: f.rpc,
    saved,
    consent,
    signed,
    state,
    calls,
    rpc,
    register,
    collect,
    rows,
    last,
  };
}
const collect = vi.mocked(collectPumpProgramIdentities);
async function runtimeFixture() {
  const f = await fixture();
  const provider: PumpLaunchRpc = async (method, params, signal) => {
    if (method === 'getLatestBlockhash')
      return {
        context: { slot: String(f.saved.review.simulation.sourceRecheckSlot) },
        value: {
          blockhash: f.input.create.blockhash,
          lastValidBlockHeight: f.input.create.lastValidBlockHeight.toString(),
        },
      };
    const config = params[1] as
      | { dataSlice?: { offset: number; length: number } }
      | undefined;
    if (method === 'getMultipleAccounts' && config?.dataSlice) {
      const value = (await f.preparationRpc(
        method,
        [params[0], { ...config, dataSlice: undefined }],
        signal,
      )) as { context: unknown; value: unknown[] };
      return {
        ...value,
        value: value.value.map((raw) => {
          const account = pumpRpcAccount(raw);
          if (!account) return null;
          const bytes = pumpAccountBytes(account);
          return {
            ...account,
            data: [
              Buffer.from(
                bytes.slice(
                  config.dataSlice!.offset,
                  config.dataSlice!.offset + config.dataSlice!.length,
                ),
              ).toString('base64'),
              'base64',
            ],
          };
        }),
      };
    }
    return f.preparationRpc(method, params, signal);
  };
  collect.mockImplementation(async (programs, minimumSlot, signal, rpc) => {
    const response = (await rpc(
      'getMultipleAccounts',
      [
        programs,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          minContextSlot: minimumSlot,
          dataSlice: { offset: 0, length: 45 },
        },
      ],
      signal,
    )) as { value: unknown[] };
    const identities = await Promise.all(
      programs.map(async (key, i) => {
        const account = pumpRpcAccount(response.value[i])!;
        const link = pumpGroupProgramDataLink(key, account);
        if (link)
          throw new Error('Fixture requires immutable executable programs');
        return {
          address: key,
          loader: account.owner,
          programData: null,
          deploymentSlot: null,
          upgradeAuthority: null,
          codeSha256: Buffer.from(
            await crypto.subtle.digest(
              'SHA-256',
              Uint8Array.from(pumpAccountBytes(account)),
            ),
          ).toString('hex'),
          codeBytes: pumpAccountBytes(account).length,
          identityKind:
            account.owner === 'NativeLoader1111111111111111111111111111111'
              ? ('native-system' as const)
              : ('elf-code' as const),
        };
      }),
    );
    return {
      format: 'pump-program-code-identities-v1',
      network: 'mainnet',
      minimumSlot,
      maximumSlot: minimumSlot,
      programs: identities,
      reads: 1,
      totalCodeBytes: identities.reduce((n, p) => n + p.codeBytes, 0),
      observedAt: new Date().toISOString(),
      codeIdentityVerified: true,
      semanticAuditEstablished: false,
      signingAllowed: false,
      executionAllowed: false,
    };
  });
  const preview = () =>
    previewOwnedPumpGroupRuntime(
      f.db,
      'alice',
      f.saved.review.id,
      new AbortController().signal,
      provider,
    );
  return { ...f, provider, preview };
}
const codeConsent = (
  preview: Awaited<ReturnType<typeof previewOwnedPumpGroupRuntime>>,
) => ({
  approved: true as const,
  previewId: preview.id,
  identitySha256: preview.identitySha256,
  acknowledgeUpgradeableCode: true as const,
  acknowledgeNoSemanticAudit: true as const,
});
it('requires explicit exact code consent and creates a five-second sign-only authorization after fresh owned approval', async () => {
  const f = await runtimeFixture();
  const preview = await f.preview();
  expect(preview.signingAllowed).toBe(false);
  expect(preview.semanticAuditEstablished).toBe(false);
  const result = await authorizeOwnedPumpGroupSigning(
    f.db,
    'alice',
    f.saved.review.id,
    preview.id,
    f.consent,
    codeConsent(preview),
    new AbortController().signal,
    f.provider,
  );
  expect(result.group.state).toBe('approved');
  expect(
    requirePumpSigningAuthorization(
      result.authorization,
      preview,
      result.group.review,
    ),
  ).toMatchObject({
    signingAllowed: true,
    executionAllowed: false,
    submissionAllowed: false,
    scope: 'sign-complete-group-only',
  });
  expect(
    Date.parse(result.authorization.expiresAt) -
      Date.parse(result.authorization.createdAt),
  ).toBeLessThanOrEqual(5000);
  await expect(
    f.client.execute(
      'UPDATE pump_group_runtime_reviews SET expires_at=created_at',
    ),
  ).rejects.toThrow('Immutable');
  await expect(
    f.client.execute('DELETE FROM pump_group_signing_authorizations'),
  ).rejects.toThrow('retained');
});
it('rejects changed full code even when deployment headers remain unchanged', async () => {
  const f = await runtimeFixture();
  const preview = await f.preview();
  const original = collect.getMockImplementation()!;
  collect.mockImplementation(async (...args) => {
    const measured = await original(...args);
    measured.programs[0].codeSha256 = 'f'.repeat(64);
    return measured;
  });
  await expect(
    authorizeOwnedPumpGroupSigning(
      f.db,
      'alice',
      f.saved.review.id,
      preview.id,
      f.consent,
      codeConsent(preview),
      new AbortController().signal,
      f.provider,
    ),
  ).rejects.toThrow('code changed');
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM pump_group_signing_authorizations',
      )
    ).rows[0].n,
  ).toBe(0);
});
it('refuses mismatched code consent before recording group approval', async () => {
  const f = await runtimeFixture();
  const preview = await f.preview();
  await expect(
    authorizeOwnedPumpGroupSigning(
      f.db,
      'alice',
      f.saved.review.id,
      preview.id,
      f.consent,
      { ...codeConsent(preview), identitySha256: 'f'.repeat(64) },
      new AbortController().signal,
      f.provider,
    ),
  ).rejects.toThrow('exact code');
  expect(
    (await f.client.execute('SELECT state FROM pump_launch_reviews')).rows[0]
      .state,
  ).toBe('review');
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM pump_group_signing_authorizations',
      )
    ).rows[0].n,
  ).toBe(0);
});
it('refuses unknown owners and code preview substitution', async () => {
  const f = await runtimeFixture();
  const preview = await f.preview();
  await expect(
    authorizeOwnedPumpGroupSigning(
      f.db,
      'bob',
      f.saved.review.id,
      preview.id,
      f.consent,
      codeConsent(preview),
      new AbortController().signal,
      f.provider,
    ),
  ).rejects.toThrow('not found');
  const other = {
    ...preview,
    identitySha256: 'f'.repeat(64),
    programs: preview.programs.slice(1),
  };
  expect(
    await pumpHolderDigest({
      reviewId: other.reviewId,
      contextSha256: other.contextSha256,
      programs: other.programs,
    }),
  ).not.toBe(preview.identitySha256);
  await expect(
    f.client.execute({
      sql: 'INSERT INTO pump_group_signing_authorizations VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      args: [
        crypto.randomUUID(),
        'alice',
        f.saved.review.id,
        preview.id,
        preview.contextSha256,
        preview.identitySha256,
        '{}',
        '{}',
        '{}',
        new Date().toISOString(),
        new Date(Date.now() + 5000).toISOString(),
      ],
    }),
  ).rejects.toThrow();
});
it('rechecks signer ownership at the exact SQL authorization boundary after code headers were read', async () => {
  const f = await runtimeFixture();
  const preview = await f.preview();
  let armed = false;
  const provider: PumpLaunchRpc = async (method, params, signal) => {
    const value = await f.provider(method, params, signal);
    const config = params[1] as { dataSlice?: { length?: number } } | undefined;
    if (
      armed &&
      method === 'getMultipleAccounts' &&
      config?.dataSlice?.length === 45
    ) {
      await f.client.execute({
        sql: 'UPDATE workspace_wallets SET archived=1 WHERE address=?',
        args: [f.saved.review.input.holders[0].address],
      });
    }
    return value;
  };
  armed = true;
  await expect(
    authorizeOwnedPumpGroupSigning(
      f.db,
      'alice',
      f.saved.review.id,
      preview.id,
      f.consent,
      codeConsent(preview),
      new AbortController().signal,
      provider,
    ),
  ).rejects.toThrow();
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM pump_group_signing_authorizations',
      )
    ).rows[0].n,
  ).toBe(0);
});
