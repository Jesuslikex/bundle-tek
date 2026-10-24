import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  launchRecoveryInspectionUrl,
  launchInspectionRequest,
  validateLaunchInspectionReference,
  validateLaunchRecoveryInspection,
  readLaunchRecoveryInspection,
  type LaunchInspectionReference,
  type LaunchRecoveryInspection,
} from './launch-recovery-inspection';
const ref: LaunchInspectionReference = {
  source: 'pump',
  reviewKind: 'create',
  id: 'original-record',
  projectId: 'original-project',
  mint: bs58.encode(new Uint8Array(32).fill(1)),
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-10-01T00:01:00.000Z',
};
function value(): LaunchRecoveryInspection {
  return {
    format: 'launch-recovery-inspection-v1',
    reference: { ...ref },
    inspectedAt: '2026-10-24T00:00:00.000Z',
    recordedState: 'finalized',
    name: 'Original saved name',
    symbol: 'OLD',
    payer: bs58.encode(new Uint8Array(32).fill(2)),
    payerRevision: null,
    projectUpdatedAt: null,
    quoteMint: null,
    hashes: [{ kind: 'packet', index: null, sha256: 'a'.repeat(64) }],
    budgets: [
      {
        kind: 'fee-rent-limit',
        address: null,
        raw: '9007199254740993',
        units: 'lamports',
      },
      {
        kind: 'developer-max-quote',
        address: null,
        raw: null,
        units: 'raw-quote',
      },
    ],
    participants: [
      {
        role: 'developer',
        address: bs58.encode(new Uint8Array(32).fill(2)),
        mode: 'not-requested',
      },
    ],
    signature: null,
    signatureScope: 'single-transaction',
    receiptPresent: true,
    packetCount: 1,
    signingAllowed: false,
    executionAllowed: false,
    receiptVerified: false,
  };
}
it('preserves historical state progression, original expired reference, large exact raw values and unknown limits without authority', () => {
  const result = validateLaunchRecoveryInspection(value(), ref);
  expect(result.recordedState).toBe('finalized');
  expect(result.receiptVerified).toBe(false);
  expect(result.budgets[0].raw).toBe('9007199254740993');
  expect(result.budgets[1].raw).toBeNull();
  expect(result.quoteMint).toBeNull();
});
it('builds only exact owner-read inspection query, never a provider/status fallback', () => {
  const url = launchRecoveryInspectionUrl(ref);
  expect(url.startsWith('/api/account-launch-recoveries?')).toBe(true);
  const params = new URL(url, 'https://bundle.test').searchParams;
  expect(launchInspectionRequest(params)).toEqual(ref);
  expect(
    launchInspectionRequest(new URLSearchParams('cursor=position')),
  ).toBeNull();
});
it.each(['view=unknown', 'view=inspection', 'view=inspection&owner=other'])(
  'refuses malformed inspection mode %s',
  (query) =>
    expect(() => launchInspectionRequest(new URLSearchParams(query))).toThrow(),
);
it('rejects duplicate and additional inspection fields', () => {
  const p = new URL(launchRecoveryInspectionUrl(ref), 'https://x.test')
    .searchParams;
  for (const [key, v] of [
    ['id', 'other'],
    ['owner', 'bob'],
    ['cursor', 'foo'],
  ]) {
    const next = new URLSearchParams(p);
    next.append(key, v);
    expect(() => launchInspectionRequest(next)).toThrow();
  }
});
it('preserves unknown format reference but refuses to invent an inspection route', () => {
  const unknown = { ...ref, reviewKind: 'uncategorized' as const };
  expect(validateLaunchInspectionReference(unknown)).toEqual(unknown);
  expect(() => launchRecoveryInspectionUrl(unknown)).toThrow(
    'cannot be inspected',
  );
});
it.each([
  'source',
  'reviewKind',
  'id',
  'projectId',
  'mint',
  'createdAt',
  'expiresAt',
] as const)('rejects replacement of immutable %s', (key) => {
  const other = {
    ...ref,
    [key]:
      key === 'id'
        ? 'other'
        : key === 'createdAt'
          ? '2026-09-01T00:00:00.000Z'
          : key === 'expiresAt'
            ? '2026-10-01T00:02:00.000Z'
            : key === 'mint'
              ? bs58.encode(new Uint8Array(32).fill(4))
              : key === 'source'
                ? 'stonkfun'
                : key === 'reviewKind'
                  ? 'developer'
                  : 'other-project',
  };
  expect(() =>
    validateLaunchRecoveryInspection({ ...value(), reference: other }, ref),
  ).toThrow();
});
it.each([
  { signingAllowed: true },
  { executionAllowed: true },
  { receiptVerified: true },
  { transaction: 'UNSIGNED' },
  { signedEvidence: { secret: 'SIGNED' } },
  { receipt: { raw: 'PRIVATE' } },
  { recordedState: 'unknown' },
  { signature: 'bad' },
  { signatureScope: 'whole-group' },
  { payer: 'bad' },
  { quoteMint: 'bad' },
  { name: 'bad\nname' },
  { projectUpdatedAt: 'bad' },
  { packetCount: 2 },
])('refuses malformed or authority-bearing output %#', (change) =>
  expect(() =>
    validateLaunchRecoveryInspection({ ...value(), ...change }, ref),
  ).toThrow(),
);
it.each([
  { raw: 0 },
  { raw: '00' },
  { raw: '1.5' },
  { raw: '-1' },
  { raw: '1e9' },
  { raw: '9'.repeat(81) },
  { units: 'raw-token' },
  { unknown: 'extra' },
])('rejects malformed budget or unit mismatch %#', (change) => {
  const current = value();
  current.budgets = [
    { ...current.budgets[0], ...change },
  ] as LaunchRecoveryInspection['budgets'];
  expect(() => validateLaunchRecoveryInspection(current, ref)).toThrow();
});
it('rejects duplicate or omitted hashes and budget rows', () => {
  const current = value();
  expect(() =>
    validateLaunchRecoveryInspection(
      { ...current, hashes: [...current.hashes, ...current.hashes] },
      ref,
    ),
  ).toThrow();
  expect(() =>
    validateLaunchRecoveryInspection({ ...current, hashes: [] }, ref),
  ).toThrow();
  expect(() =>
    validateLaunchRecoveryInspection(
      { ...current, budgets: [...current.budgets, ...current.budgets] },
      ref,
    ),
  ).toThrow();
});
it('requires every original packet hash and distinct first-packet signature scope for groups', () => {
  const groupRef = { ...ref, reviewKind: 'groups' as const };
  const group = {
    ...value(),
    reference: groupRef,
    signatureScope: 'first-group-packet' as const,
    packetCount: 2,
    hashes: [
      { kind: 'manifest' as const, index: null, sha256: 'b'.repeat(64) },
      ...Array.from({ length: 2 }, (_, index) => ({
        kind: 'packet' as const,
        index,
        sha256: String(index + 1).repeat(64),
      })),
    ],
  };
  expect(validateLaunchRecoveryInspection(group, groupRef).packetCount).toBe(2);
  expect(() =>
    validateLaunchRecoveryInspection(
      { ...group, hashes: group.hashes.slice(1) },
      groupRef,
    ),
  ).toThrow();
  expect(() =>
    validateLaunchRecoveryInspection(
      { ...group, hashes: group.hashes.slice(0, 2) },
      groupRef,
    ),
  ).toThrow();
});
it('refuses accessors without invoking them', () => {
  let calls = 0;
  const input = { ...value() };
  Object.defineProperty(input, 'name', {
    enumerable: true,
    get() {
      calls++;
      return 'wrong';
    },
  });
  expect(() => validateLaunchRecoveryInspection(input, ref)).toThrow();
  expect(calls).toBe(0);
});
it('bounds arrays and rejects sparse lists', () => {
  const current = value();
  expect(() =>
    validateLaunchRecoveryInspection(
      { ...current, budgets: Object.assign([], { length: 1 }) },
      ref,
    ),
  ).toThrow();
  expect(() =>
    validateLaunchRecoveryInspection(
      {
        ...current,
        budgets: Array.from({ length: 1601 }, () => current.budgets[0]),
      },
      ref,
    ),
  ).toThrow();
});
it('reads only bounded JSON and never echoes rejected HTTP bodies', async () => {
  for (const status of [401, 404, 409, 503]) {
    const cancel = vi.fn();
    await expect(
      readLaunchRecoveryInspection(
        new Response(new ReadableStream({ cancel }), { status }),
        ref,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status });
    expect(cancel).toHaveBeenCalledOnce();
  }
  await expect(
    readLaunchRecoveryInspection(
      Response.json(value()),
      ref,
      new AbortController().signal,
    ),
  ).resolves.toEqual(value());
  await expect(
    readLaunchRecoveryInspection(
      new Response('<html>PRIVATE</html>'),
      ref,
      new AbortController().signal,
    ),
  ).rejects.toThrow('unavailable');
});
it('prioritizes abort over401 and cancels an in-progress body', async () => {
  const controller = new AbortController(),
    cancel = vi.fn(),
    reason = Error('stopped');
  controller.abort(reason);
  await expect(
    readLaunchRecoveryInspection(
      new Response(null, { status: 401 }),
      ref,
      controller.signal,
    ),
  ).rejects.toBe(reason);
  const active = new AbortController();
  const pending = readLaunchRecoveryInspection(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }),
    ref,
    active.signal,
  );
  active.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(['\u202e', '\u2066'])(
  'refuses bidi control in saved display text %s',
  (control) => {
    expect(() =>
      validateLaunchRecoveryInspection(
        { ...value(), name: 'saved' + control + 'name' },
        ref,
      ),
    ).toThrow();
  },
);
it('refuses missing, duplicate, mismatched and excessive recorded participants', () => {
  const v = value();
  for (const participants of [
    [],
    [...v.participants, ...v.participants],
    [{ ...v.participants[0], address: ref.mint }],
    [{ ...v.participants[0], mode: 'executed' }],
  ])
    expect(() =>
      validateLaunchRecoveryInspection({ ...v, participants }, ref),
    ).toThrow();
});
