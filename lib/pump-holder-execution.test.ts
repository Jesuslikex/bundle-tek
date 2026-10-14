import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { preflightOwnedPumpHolderSimulation } from './pump-holder-preparation';
import {
  approvePumpHolderReview,
  registerPumpHolderSignedPacket,
  listPumpHolderReviews,
} from './pump-holder-review-service';
import {
  submitPumpHolderReview,
  recoverPumpHolderReview,
  cancelPumpHolderReview,
} from './pump-holder-execution';
import {
  pumpHolderReviewServiceFixture,
  signSyntheticPumpHolder,
  holderConsent,
  holderTestSignal as signal,
} from '../test/pump-holder-review-fixture';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';
vi.mock('./pump-holder-preparation', async (original) => ({
  ...(await original<typeof import('./pump-holder-preparation')>()),
  preflightOwnedPumpHolderSimulation: vi.fn(),
}));
const mocked = vi.mocked(preflightOwnedPumpHolderSimulation),
  clients: Client[] = [];
beforeEach(() => {
  mocked.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.close();
});

async function fixture(signed = true) {
  const f = await pumpHolderReviewServiceFixture(mocked, clients),
    prepared = await f.prepare(),
    consent = holderConsent(prepared.review);
  await approvePumpHolderReview(
    f.db,
    'alice',
    prepared.review.id,
    consent,
    signal(),
    f.rpc,
  );
  const packet = signed
    ? await signSyntheticPumpHolder(f, prepared.review)
    : null;
  const stored = signed
    ? await registerPumpHolderSignedPacket(
        f.db,
        'alice',
        prepared.review.id,
        consent,
        packet!,
        signal(),
      )
    : prepared;
  const calls: { method: string; params: unknown[] }[] = [];
  const state = {
    sendError: false,
    wrongSignature: false,
    receipt: null as unknown,
    genesis: SOLANA_MAINNET_GENESIS,
    height: '1033',
    bankSlot: '2000',
    mintSlot: '2001',
    mint: null as unknown,
  };
  const rpc: PumpLaunchRpc = async (method, params, abort) => {
    abort.throwIfAborted();
    calls.push({ method, params });
    if (method === 'sendTransaction') {
      const row = await f.client.execute(
        'SELECT state FROM pump_launch_reviews',
      );
      expect(row.rows[0].state).toBe('submitting');
      if (state.sendError) throw new Error('Lost response');
      return state.wrongSignature ? 'different' : stored.signature;
    }
    if (method === 'getGenesisHash') return state.genesis;
    if (method === 'getTransaction') return state.receipt;
    if (method === 'getEpochInfo')
      return { absoluteSlot: state.bankSlot, blockHeight: state.height };
    if (method === 'getAccountInfo')
      return { context: { slot: state.mintSlot }, value: state.mint };
    throw new Error('Unexpected execution RPC method: ' + method);
  };
  const submit = (approved = true) =>
    submitPumpHolderReview(
      f.db,
      'alice',
      prepared.review.id,
      { consent, submitApproved: approved as true },
      signal(),
      rpc,
    );
  const recover = () =>
    recoverPumpHolderReview(f.db, 'alice', prepared.review.id, signal(), rpc);
  return {
    ...f,
    prepared,
    consent,
    packet,
    stored,
    calls,
    state,
    rpc,
    submit,
    recover,
  };
}
it('refreshes and persists submitting before exactly one separately approved send', async () => {
  const f = await fixture();
  expect(await f.submit()).toMatchObject({
    state: 'submitted',
    completeLaunch: false,
  });
  expect(f.calls).toEqual([
    {
      method: 'sendTransaction',
      params: [
        f.packet,
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 0,
          minContextSlot: 100,
        },
      ],
    },
  ]);
  expect(mocked).toHaveBeenCalledTimes(3);
  expect(await f.submit()).toMatchObject({ state: 'submitted' });
  expect(f.calls).toHaveLength(1);
  expect(mocked).toHaveBeenCalledTimes(3);
});
it('requires separate broadcast consent and a fully signed review', async () => {
  const f = await fixture();
  await expect(f.submit(false)).rejects.toMatchObject({ status: 400 });
  expect(f.calls).toEqual([]);
  expect(mocked).toHaveBeenCalledTimes(2);
  const unsigned = await fixture(false);
  await expect(unsigned.submit()).rejects.toThrow(
    'Register every holder signature',
  );
  expect(unsigned.calls).toEqual([]);
});
it('never resends after a lost send response or a different provider signature', async () => {
  for (const kind of ['sendError', 'wrongSignature'] as const) {
    const f = await fixture();
    f.state[kind] = true;
    expect(await f.submit()).toMatchObject({
      state: 'submitting',
      signature: f.stored.signature,
    });
    expect(await f.submit()).toMatchObject({ state: 'submitting' });
    expect(f.calls.filter((c) => c.method === 'sendTransaction')).toHaveLength(
      1,
    );
  }
});
it('rejects changed settlement or expired reviews before attempting a send', async () => {
  const f = await fixture();
  f.checked.allWalletSimulation.accounting.totalQuoteDebitRaw = '1';
  await expect(f.submit()).rejects.toThrow(
    'settlement or observed source changed',
  );
  expect(f.calls).toEqual([]);
  const expired = await fixture();
  vi.spyOn(Date, 'now').mockReturnValue(
    Date.parse(expired.prepared.review.expiresAt) + 1,
  );
  await expect(expired.submit()).rejects.toThrow('expired');
  expect(expired.calls).toEqual([]);
});
it('allows only one concurrent submit call to reach the provider', async () => {
  const f = await fixture(),
    waiters: (() => void)[] = [];
  f.setHook(
    () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (waiters.length === 2) for (const done of waiters) done();
      }),
  );
  const results = await Promise.allSettled([f.submit(), f.submit()]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.calls.filter((c) => c.method === 'sendTransaction')).toHaveLength(1);
});
it('releases successful finalized history only for the exact packet, signatures and context', async () => {
  const f = await fixture();
  f.state.sendError = true;
  await f.submit();
  f.state.receipt = {
    slot: '2000',
    transaction: [f.packet, 'base64'],
    meta: { err: null, fee: '20000' },
  };
  const recovered = await f.recover();
  expect(recovered).toMatchObject({
    state: 'finalized',
    completeLaunch: true,
    receipt: {
      kind: 'finalized',
      commitment: 'finalized',
      succeeded: true,
      containsHolderBuys: true,
      activeHolderCount: 2,
      packetSha256: f.prepared.review.sha256,
      contextSha256: f.prepared.review.contextSha256,
      networkFeeRaw: '20000',
    },
  });
  const receiptRead = f.calls.find((c) => c.method === 'getTransaction')!;
  expect(receiptRead.params[1]).toEqual({
    encoding: 'base64',
    commitment: 'finalized',
    maxSupportedTransactionVersion: 1,
  });
  const count = f.calls.length;
  expect(await f.recover()).toEqual(recovered);
  expect(f.calls).toHaveLength(count);
  expect(f.calls.filter((c) => c.method === 'sendTransaction')).toHaveLength(1);
});
it('records exact finalized failure and keeps completion false', async () => {
  const f = await fixture();
  f.state.receipt = {
    slot: '2000',
    transaction: [f.packet, 'base64'],
    meta: { err: { InstructionError: ['1', 'Custom'] }, fee: '20000' },
  };
  expect(await f.recover()).toMatchObject({
    state: 'failed',
    completeLaunch: false,
    receipt: { succeeded: false },
  });
});
it('keeps reservations for a mismatched receipt or wrong network', async () => {
  const f = await fixture();
  f.state.receipt = {
    slot: '2000',
    transaction: [f.prepared.review.transaction, 'base64'],
    meta: { err: null },
  };
  await expect(f.recover()).rejects.toThrow('receipt packet');
  expect((await listPumpHolderReviews(f.db, 'alice', 'holders'))[0].state).toBe(
    'signed',
  );
  f.state.genesis = 'wrong';
  await expect(f.recover()).rejects.toThrow('not Solana mainnet');
  expect(f.calls.some((c) => c.method === 'sendTransaction')).toBe(false);
});
it('uses linked finalized expiry and mint absence to safely cancel while retaining unresolved fees', async () => {
  const f = await fixture();
  const result = await f.recover();
  expect(result).toMatchObject({
    state: 'cancelled',
    completeLaunch: false,
    receipt: {
      kind: 'expired-unobserved',
      finalizedBlockHeight: '1033',
      expiryBankSlot: '2000',
      mintObservedSlot: '2001',
      mintAbsent: true,
      networkFeeUnresolved: true,
      signatureKnown: true,
    },
  });
  expect(f.calls.find((c) => c.method === 'getAccountInfo')?.params[1]).toEqual(
    { encoding: 'base64', commitment: 'finalized', minContextSlot: 2000 },
  );
  expect(await f.submit()).toMatchObject({ state: 'cancelled' });
  expect(f.calls.some((c) => c.method === 'sendTransaction')).toBe(false);
});
it('does not cancel before the expiry margin or while a mint may already exist', async () => {
  const f = await fixture();
  f.state.height = '1032';
  expect(await f.recover()).toMatchObject({ state: 'signed', receipt: null });
  expect(f.calls.some((c) => c.method === 'getAccountInfo')).toBe(false);
  f.state.height = '1033';
  f.state.mint = {};
  expect(await f.recover()).toMatchObject({ state: 'signed', receipt: null });
});
it('rejects stale or impossible expiry observations instead of releasing wallets', async () => {
  for (const patch of [
    { mintSlot: '1999' },
    { bankSlot: '99' },
    { height: '2001' },
    { mintSlot: '9999999' },
  ]) {
    const f = await fixture();
    Object.assign(f.state, patch);
    await expect(f.recover()).rejects.toThrow();
    expect(
      (await listPumpHolderReviews(f.db, 'alice', 'holders'))[0].state,
    ).toBe('signed');
  }
});
it('recovers an approved but unregistered packet only after expiry proof', async () => {
  const f = await fixture(false);
  expect(
    await cancelPumpHolderReview(
      f.db,
      'alice',
      f.prepared.review.id,
      signal(),
      f.rpc,
    ),
  ).toMatchObject({
    state: 'cancelled',
    receipt: { signatureKnown: false, networkFeeUnresolved: true },
  });
  expect(f.calls.some((c) => c.method === 'getTransaction')).toBe(false);
});
it('rejects ownership revoked at the submitting write without contacting the sender', async () => {
  const f = await fixture();
  f.setHook(async () => {
    await f.client.execute({
      sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
      args: [f.terms.holderLimits[0].address],
    });
  });
  await expect(f.submit()).rejects.toThrow('Holder wallet proof');
  expect(f.calls).toEqual([]);
  expect((await listPumpHolderReviews(f.db, 'alice', 'holders'))[0].state).toBe(
    'signed',
  );
});
it('holds the reservation for malformed finalized receipt metadata', async () => {
  const f = await fixture();
  for (const patch of [
    { meta: {} },
    { meta: { err: false } },
    { slot: '99' },
    { transaction: [f.packet, 'json'] },
    { meta: { err: null, fee: '-1' } },
  ]) {
    f.state.receipt = {
      slot: '2000',
      transaction: [f.packet, 'base64'],
      meta: { err: null },
      ...patch,
    };
    await expect(f.recover()).rejects.toThrow();
    expect(
      (await listPumpHolderReviews(f.db, 'alice', 'holders'))[0].state,
    ).toBe('signed');
  }
});
it('rechecks mainnet before committing a finalized receipt', async () => {
  const f = await fixture();
  f.state.receipt = {
    slot: '2000',
    transaction: [f.packet, 'base64'],
    meta: { err: null },
  };
  let genesisReads = 0;
  const switched: PumpLaunchRpc = (method, params, abort) =>
    method === 'getGenesisHash'
      ? Promise.resolve(++genesisReads === 1 ? SOLANA_MAINNET_GENESIS : 'wrong')
      : f.rpc(method, params, abort);
  await expect(
    recoverPumpHolderReview(
      f.db,
      'alice',
      f.prepared.review.id,
      signal(),
      switched,
    ),
  ).rejects.toThrow('not Solana mainnet');
  expect((await listPumpHolderReviews(f.db, 'alice', 'holders'))[0].state).toBe(
    'signed',
  );
});
it('cancels an initial unsigned review without requiring a provider read', async () => {
  const f = await pumpHolderReviewServiceFixture(mocked, clients),
    prepared = await f.prepare();
  expect(
    await cancelPumpHolderReview(
      f.db,
      'alice',
      prepared.review.id,
      signal(),
      f.rpc,
    ),
  ).toMatchObject({ state: 'cancelled', receipt: null });
});
