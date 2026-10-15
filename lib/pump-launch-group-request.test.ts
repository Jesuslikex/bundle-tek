import { beforeAll, expect, it } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import {
  parsePumpGroupRequest,
  parsePumpGroupReadRequest,
  encodePumpGroupObservationCursor,
} from './pump-launch-group-request';
const origin = 'https://bundle.test',
  id = '11111111-1111-4111-8111-111111111111';
const consent = {
  approved: true,
  reviewId: id,
  manifestSha256: 'a'.repeat(64),
  contextSha256: 'b'.repeat(64),
  simulationSha256: 'c'.repeat(64),
  approvedScope: 'complete-create-developer-holder-packet-group',
  acknowledgeSimulationLimits: true,
};
let wallets: string[];
beforeAll(async () => {
  wallets = await Promise.all(
    Array.from(
      { length: 202 },
      async () => (await generateKeyPairSigner()).address,
    ),
  );
});
const prepare = () => ({
  action: 'prepare',
  projectId: 'p1',
  updatedAt: '2026-10-15T00:00:00.000Z',
  releaseId: 'a'.repeat(64),
  payer: wallets[0],
  mint: wallets[1],
  payerRevision: 1,
  feeAndRentLimitRaw: '10000000',
  holderLimits: wallets
    .slice(2)
    .map((address) => ({ address, feeAndRentLimitRaw: '0' })),
});
it('preserves all 200 saved slots and raw budgets with only server-derived origin', () => {
  const request = prepare(),
    r = parsePumpGroupRequest(request, origin);
  expect(r.action).toBe('prepare');
  if (r.action !== 'prepare') throw Error('Expected prepare');
  expect(r.terms.holderLimits).toEqual(request.holderLimits);
  expect(r.terms.origin).toBe(origin);
  for (const patch of [
    { ownerId: 'other' },
    { origin: 'other' },
    { simulation: {} },
    { holders: [] },
    { rpcUrl: 'https://other.test' },
    { feeAndRentLimitRaw: '1.0' },
    { holderLimits: [...request.holderLimits, request.holderLimits[0]] },
  ])
    expect(() =>
      parsePumpGroupRequest({ ...request, ...patch }, origin),
    ).toThrow();
});
it('requires exact complete-group consent and rejects caller-authored execution or source fields', () => {
  expect(
    parsePumpGroupRequest({ action: 'approve', id, consent }, origin),
  ).toEqual({ action: 'approve', id, consent });
  for (const patch of [
    { approved: false },
    { reviewId: 'other' },
    { simulationSha256: 'x' },
    { manifestSha256: 'x' },
    { contextSha256: 'x' },
    { approvedScope: 'create-only' },
    { acknowledgeSimulationLimits: false },
    { extra: true },
  ])
    expect(() =>
      parsePumpGroupRequest(
        { action: 'approve', id, consent: { ...consent, ...patch } },
        origin,
      ),
    ).toThrow();
  for (const action of ['submit', 'send', 'recover', 'sign'])
    expect(() =>
      parsePumpGroupRequest(
        { action, id, consent, submitApproved: true },
        origin,
      ),
    ).toThrow();
});
it('accepts only complete bounded canonical packet vectors for registration', () => {
  expect(
    parsePumpGroupRequest(
      { action: 'register', id, consent, transactions: ['AQ==', 'Ag=='] },
      origin,
    ).action,
  ).toBe('register');
  for (const transactions of [
    [],
    Array(6).fill('AQ=='),
    ['AQ==', 'AQ=='],
    ['AQ'],
    ['?'],
    [Buffer.alloc(4097).toString('base64')],
    [1],
  ])
    expect(() =>
      parsePumpGroupRequest(
        { action: 'register', id, consent, transactions },
        origin,
      ),
    ).toThrow();
  expect(() =>
    parsePumpGroupRequest(
      {
        action: 'register',
        id,
        consent,
        transactions: ['AQ=='],
        signedEvidence: {},
      },
      origin,
    ),
  ).toThrow();
});
it('allows only exact review IDs for read-only revalidation/observation and unsigned cancellation', () => {
  for (const action of ['revalidate', 'observe', 'cancel']) {
    expect(parsePumpGroupRequest({ action, id }, origin)).toEqual({
      action,
      id,
    });
    expect(() =>
      parsePumpGroupRequest({ action, id, observation: {} }, origin),
    ).toThrow();
    expect(() =>
      parsePumpGroupRequest({ action, id: 'bad' }, origin),
    ).toThrow();
  }
});
it('binds observation positions to exact review/type and keeps their representation canonical', () => {
  const position = {
      reviewId: id,
      id: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-10-15T00:00:00.000Z',
    },
    cursor = encodePumpGroupObservationCursor(position);
  expect(
    parsePumpGroupReadRequest(
      new URLSearchParams({ id, observations: '1', cursor }),
    ),
  ).toEqual({ kind: 'observations', id, position });
  const invalid: Record<string, string>[] = [
    { id: '33333333-3333-4333-8333-333333333333', observations: '1', cursor },
    { id, observations: '0', cursor },
    { id, cursor },
    { projectId: 'p1', page: '1', cursor },
    { id, observations: '1', cursor: cursor + '=' },
    {
      id,
      observations: '1',
      cursor: Buffer.from(
        JSON.stringify({ ...position, v: 1, kind: 'holders' }),
      ).toString('base64url'),
    },
  ];
  for (const params of invalid)
    expect(() =>
      parsePumpGroupReadRequest(new URLSearchParams(params)),
    ).toThrow();
});
it('rejects ambiguous, cross-scope or unknown GET parameters and defaults project history to its first page', () => {
  expect(
    parsePumpGroupReadRequest(new URLSearchParams({ projectId: 'p1' })),
  ).toEqual({ kind: 'projects', projectId: 'p1', page: { before: null } });
  expect(parsePumpGroupReadRequest(new URLSearchParams({ id }))).toEqual({
    kind: 'review',
    id,
  });
  for (const query of [
    'id=' + id + '&id=' + id,
    'projectId=p1&ownerId=bob',
    'id=' + id + '&projectId=p1',
    'projectId=p1&cursor=bad',
    'id=' + id + '&observations=1&other=1',
    'projectId=',
    'id=bad',
  ])
    expect(() =>
      parsePumpGroupReadRequest(new URLSearchParams(query)),
    ).toThrow();
});
