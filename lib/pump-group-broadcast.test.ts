import { beforeAll, expect, it, vi } from 'vitest';
import { pumpGroupBroadcastClientFixture } from '../test/pump-group-broadcast-client-fixture';
import {
  requirePumpGroupBroadcastReview,
  requirePumpGroupBroadcastConsent,
  verifyPumpGroupTip,
  signPumpGroupTip,
  pumpGroupJitoStatus,
} from './pump-group-broadcast';
import { parsePumpGroupBroadcastState } from './pump-group-broadcast-client';
import { parsePumpGroupRequest } from './pump-launch-group-request';
import type { VaultSession } from './browser-wallet-vault';
vi.mock('@solana/kit', async (original) => {
  const actual = await original<typeof import('@solana/kit')>();
  return {
    ...actual,
    generateKeyPairSigner: () => actual.generateKeyPairSigner(true),
  };
});
vi.mock('@solana/kit-v1', async (original) => {
  const actual = await original<typeof import('@solana/kit-v1')>();
  return {
    ...actual,
    generateKeyPairSigner: () => actual.generateKeyPairSigner(true),
  };
});
let f: Awaited<ReturnType<typeof pumpGroupBroadcastClientFixture>>;
it('normalizes Jito numeric or decimal slots and accepts only the exact finalized signature vector', () => {
  const id = 'a'.repeat(64),
    signatures = ['first', 'tip'];
  const status = {
    bundle_id: id,
    confirmation_status: 'finalized',
    err: { Ok: null },
    slot: 250,
    transactions: signatures,
  };
  expect(pumpGroupJitoStatus({ value: [status] }, id, signatures)).toEqual({
    bundleId: id,
    finalized: true,
    slot: '250',
  });
  expect(
    pumpGroupJitoStatus({ value: [{ ...status, slot: '250' }] }, id, signatures)
      .finalized,
  ).toBe(true);
  for (const patch of [
    { slot: Number.MAX_SAFE_INTEGER + 1 },
    { transactions: ['tip', 'first'] },
    { err: { Err: 'failed' } },
    { bundle_id: 'b'.repeat(64) },
  ])
    expect(
      pumpGroupJitoStatus({ value: [{ ...status, ...patch }] }, id, signatures)
        .finalized,
    ).toBe(false);
});
beforeAll(async () => {
  f = await pumpGroupBroadcastClientFixture();
}, 30000);
it('binds the entire immutable signed vector, tip, extra budgets and endpoint without claiming atomic execution', async () => {
  expect(
    await requirePumpGroupBroadcastReview(f.review, f.group.review),
  ).toEqual(f.review);
  expect(await parsePumpGroupBroadcastState(f.state, f.group)).toEqual(f.state);
  for (const patch of [
    { endpoint: 'https://other.test' },
    { tipRaw: '999' },
    { tipFeeLimitRaw: '100001' },
    { contextSha256: 'f'.repeat(64) },
    { transactions: f.review.transactions.slice(1) },
    { tipTransaction: 'AQ==' },
    { completeLaunch: true },
  ])
    await expect(
      requirePumpGroupBroadcastReview(
        { ...f.review, ...patch } as typeof f.review,
        f.group.review,
      ),
    ).rejects.toThrow();
});
it('verifies the exact single-transfer tip and refuses changed bytes or caller-authored signature evidence', async () => {
  expect(await verifyPumpGroupTip(f.review, f.tip.transaction)).toEqual(f.tip);
  const bytes = Buffer.from(f.tip.transaction, 'base64');
  bytes[66] ^= 1;
  await expect(
    verifyPumpGroupTip(f.review, bytes.toString('base64')),
  ).rejects.toThrow();
  await expect(
    parsePumpGroupBroadcastState(
      { ...f.state, tip: { ...f.tip, signature: 'x' } },
      f.group,
    ),
  ).rejects.toThrow();
  await expect(
    parsePumpGroupBroadcastState(
      { ...f.state, reservationsReleased: true },
      f.group,
    ),
  ).rejects.toThrow();
});
it('signs only after a live context guard and clears temporary secrets while preserving caller vault ownership', async () => {
  const der = new Uint8Array(
      await crypto.subtle.exportKey(
        'pkcs8',
        f.f.fixture.f.f.payerSigner.keyPair.privateKey,
      ),
    ),
    seed = Buffer.from(der.slice(-32)).toString('hex');
  const session = {
    payload: { wallets: [{ family: 'solana', address: f.review.payer, seed }] },
  } as VaultSession;
  const guard = vi.fn(() => undefined),
    signal = new AbortController().signal;
  expect(
    await signPumpGroupTip(session, f.review, f.group.review, guard, signal),
  ).toEqual(f.tip);
  expect(guard.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(session.payload.wallets[0].seed).toBe(seed);
  await expect(
    signPumpGroupTip(
      session,
      f.review,
      f.group.review,
      () => {
        throw new Error('Context replaced');
      },
      signal,
    ),
  ).rejects.toThrow('Context replaced');
  const controller = new AbortController();
  controller.abort();
  await expect(
    signPumpGroupTip(
      session,
      f.review,
      f.group.review,
      guard,
      controller.signal,
    ),
  ).rejects.toThrow();
});
it('requires separate exact one-attempt broadcast consent and rejects arbitrary endpoints, owners and send actions', () => {
  const consent = {
    approved: true as const,
    reviewId: f.review.reviewId,
    broadcastId: f.review.id,
    broadcastSha256: f.review.sha256,
    signedGroupSha256: f.review.signedGroupSha256,
    scope: 'one-attempt-jito-complete-group-and-tip' as const,
    acknowledgeUncertainOutcome: true as const,
  };
  expect(() =>
    requirePumpGroupBroadcastConsent(f.review, consent),
  ).not.toThrow();
  expect(
    parsePumpGroupRequest(
      { action: 'broadcast-submit', id: f.review.reviewId, consent },
      'https://bundle.test',
    ),
  ).toEqual({ action: 'broadcast-submit', id: f.review.reviewId, consent });
  for (const patch of [
    { approved: false },
    { acknowledgeUncertainOutcome: false },
    { scope: 'sign-tip-only' },
    { broadcastSha256: 'f'.repeat(64) },
    { extra: true },
  ])
    expect(() =>
      requirePumpGroupBroadcastConsent(f.review, { ...consent, ...patch }),
    ).toThrow();
  for (const patch of [
    { ownerId: 'other' },
    { endpoint: 'https://other.test' },
    { transactions: [] },
  ])
    expect(() =>
      parsePumpGroupRequest(
        {
          action: 'broadcast-submit',
          id: f.review.reviewId,
          consent,
          ...patch,
        },
        'https://bundle.test',
      ),
    ).toThrow();
  expect(
    parsePumpGroupRequest(
      {
        action: 'broadcast-prepare',
        id: f.review.reviewId,
        tipRaw: '1000',
        tipFeeLimitRaw: '5000',
      },
      'https://bundle.test',
    ).action,
  ).toBe('broadcast-prepare');
  for (const value of ['999', '1.0', '-1', '10000001'])
    expect(() =>
      parsePumpGroupRequest(
        {
          action: 'broadcast-prepare',
          id: f.review.reviewId,
          tipRaw: value,
          tipFeeLimitRaw: '5000',
        },
        'https://bundle.test',
      ),
    ).toThrow();
});
