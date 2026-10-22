import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { maximumPlanRootMeasurement } from '../test/warmup-root-capacity-measurement';
import { replayWarmupExecutionAssets } from './wallet-warmup-execution-assets-replay';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';

vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
type Measured = Awaited<ReturnType<typeof maximumPlanRootMeasurement>>;
type Packet = {
  evidence: Measured['proposal']['verifierEvidence']['assets'];
  evidenceSha256: string;
};
type Expected = {
  ownerId: string;
  reviewId: string;
  reviewSha256: string;
  sourceSnapshotSha256: string;
  evidenceSha256: string;
  provider: string;
  mints: string[];
  reviewedAt: string;
  reviewExpiresAt: string;
  expiresAt: string;
};
let original: Packet, selector: Expected;
const network = vi.fn(async () => {
  throw Error('No replay network allowed');
});
beforeAll(async () => {
  vi.stubGlobal('fetch', network);
  const f = await maximumPlanRootMeasurement();
  original = {
    evidence: f.proposal.verifierEvidence.assets,
    evidenceSha256: f.proposal.verifierEvidence.assetEvidenceSha256,
  };
  selector = {
    ownerId: f.source.ownerId,
    reviewId: f.source.retainedReview.id,
    reviewSha256: f.source.retainedReview.reviewSha256,
    sourceSnapshotSha256: f.source.sourceSnapshotSha256,
    evidenceSha256: original.evidenceSha256,
    provider: original.evidence.provider,
    mints: [
      ...new Set(f.source.retainedReview.document.actions.map((a) => a.mint)),
    ],
    reviewedAt: f.source.retainedReview.reviewedAt,
    reviewExpiresAt: f.source.retainedReview.reviewExpiresAt,
    expiresAt: original.evidence.expiresAt,
  };
});
afterAll(() => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
const signal = () => new AbortController().signal;
const fixture = () => ({
  p: structuredClone(original),
  expected: structuredClone(selector),
});
function change(value: unknown, path: (string | number)[], next: unknown) {
  let cursor = value as Record<string | number, unknown>;
  for (const part of path.slice(0, -1))
    cursor = cursor[part] as Record<string | number, unknown>;
  cursor[path.at(-1)!] = next;
}
// Deliberately rehash synthetic selectors to test semantic decoding independently
// of checksum failure. A real caller cannot replace its admitted stored selector.
async function reseal(p: Packet, expected: Expected) {
  p.evidenceSha256 = await digest(canonical(p.evidence));
  expected.evidenceSha256 = p.evidenceSha256;
}
function setClock(
  p: Packet,
  side: 'before' | 'after',
  slot?: number,
  unix?: bigint,
) {
  const a = p.evidence[side].accounts.at(-2)!.account;
  const b = Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0)),
    v = new DataView(b.buffer);
  if (slot !== undefined) v.setBigUint64(0, BigInt(slot), true);
  if (unix !== undefined) v.setBigInt64(32, unix, true);
  a.data[0] = btoa(String.fromCharCode(...b));
}

it('replays the real collector projection at20wallet/10mint capacity without new provider or authority', async () => {
  const r = await replayWarmupExecutionAssets(original, selector, signal());
  expect(r.evidence).toEqual(original.evidence);
  expect(r.evidenceSha256).toBe(selector.evidenceSha256);
  expect(r.evidence.after.accounts).toHaveLength(13);
  expect(
    r.evidence.tokenAccountRents.filter((a) => a.accountSize === 170),
  ).toHaveLength(10);
  expect(
    r.currentSourceVerified ||
      r.networkObservationReverified ||
      r.signingAllowed ||
      r.executionAllowed ||
      r.automaticExecutionAllowed,
  ).toBe(false);
});
it('does not consult current wall time or renew an old observation', async () => {
  const now = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse('2100-01-01T00:00:00.000Z'));
  try {
    const r = await replayWarmupExecutionAssets(original, selector, signal());
    expect(r.evidence.checkedAt).toBe(original.evidence.checkedAt);
    expect(r.evidence.expiresAt).toBe(original.evidence.expiresAt);
    expect(r.currentSourceVerified).toBe(false);
  } finally {
    now.mockRestore();
  }
});
it.each([
  'ownerId',
  'reviewId',
  'reviewSha256',
  'sourceSnapshotSha256',
  'evidenceSha256',
  'provider',
  'expiresAt',
] as const)('requires the separately supplied original %s', async (field) => {
  const { p, expected } = fixture();
  expected[field] =
    field === 'reviewId'
      ? crypto.randomUUID()
      : field === 'expiresAt'
        ? new Date(Date.parse(expected.expiresAt) + 1).toISOString()
        : field.endsWith('Sha256')
          ? '0'.repeat(64)
          : 'other';
  await expect(
    replayWarmupExecutionAssets(p, expected, signal()),
  ).rejects.toThrow('Retained warmup asset evidence');
});
it.each(['missing', 'reordered', 'duplicate', 'wsol', 'clock'])(
  'refuses %s expected mint membership',
  async (kind) => {
    const { p, expected } = fixture();
    if (kind === 'missing') expected.mints.pop();
    if (kind === 'reordered') expected.mints.reverse();
    if (kind === 'duplicate') expected.mints[1] = expected.mints[0];
    if (kind === 'wsol') expected.mints[0] = p.evidence.before.mints[0].address;
    if (kind === 'clock')
      expected.mints[0] = p.evidence.before.accounts.at(-2)!.address;
    await expect(
      replayWarmupExecutionAssets(p, expected, signal()),
    ).rejects.toThrow('Retained warmup asset evidence');
  },
);

const mutations: [string, (string | number)[], unknown][] = [
  ['claimed precision', ['before', 'mints', 1, 'decimals'], 5],
  [
    'claimed mint policy',
    ['after', 'mints', 1, 'policySha256'],
    '0'.repeat(64),
  ],
  ['claimed rent rate', ['before', 'rent', 'lamportsPerByte'], '1'],
  ['claimed rent threshold', ['after', 'rent', 'exemptionThreshold'], 1],
  ['claimed rent burn', ['after', 'rent', 'burnPercent'], 99],
  ['claimed Clock time', ['after', 'unixTimestamp'], '1'],
  [
    'account address',
    ['after', 'accounts', 1, 'address'],
    '11111111111111111111111111111111',
  ],
  [
    'account executable',
    ['before', 'accounts', 1, 'account', 'executable'],
    true,
  ],
  [
    'account owner',
    ['after', 'accounts', 1, 'account', 'owner'],
    '11111111111111111111111111111111',
  ],
  ['truncated mint', ['after', 'accounts', 1, 'account', 'data', 0], 'AA=='],
  [
    'wrong wire encoding',
    ['before', 'accounts', 1, 'account', 'data', 1],
    'jsonParsed',
  ],
  ['non-rent balance', ['before', 'accounts', 1, 'account', 'lamports'], '1'],
  ['non-rent size', ['before', 'accounts', 1, 'account', 'space'], '17'],
  ['rent balance zero', ['after', 'accounts', 12, 'account', 'lamports'], '0'],
  ['rent balance number', ['after', 'accounts', 12, 'account', 'lamports'], 1],
  ['rent size', ['before', 'accounts', 12, 'account', 'space'], '18'],
  ['account rent total', ['tokenAccountRents', 1, 'minimumRentLamports'], '1'],
  ['account rent size', ['tokenAccountRents', 1, 'accountSize'], 165],
  ['account rent precision', ['tokenAccountRents', 1, 'decimals'], 5],
  ['network label', ['network'], 'devnet'],
  ['commitment', ['commitment'], 'processed'],
  ['scope', ['scope'], 'runtime-qualified'],
  ['signing flag', ['signingAllowed'], true],
  ['execution flag', ['executionAllowed'], true],
  ['automatic flag', ['automaticExecutionAllowed'], true],
  ['extra evidence field', ['verified'], true],
  ['extra raw field', ['before', 'accounts', 1, 'account', 'verified'], true],
  ['noncanonical time', ['checkedAt'], '2026-10-22T00:00:00Z'],
];
it.each(mutations)(
  'refuses rehashed %s instead of trusting its claimed digest',
  async (_name, path, value) => {
    const { p, expected } = fixture();
    change(p.evidence, path, value);
    await reseal(p, expected);
    await expect(
      replayWarmupExecutionAssets(p, expected, signal()),
    ).rejects.toThrow('Retained warmup asset evidence');
  },
);
it.each([
  'missing-account',
  'reordered-account',
  'extra-account',
  'missing-mint',
  'reordered-mint',
  'missing-rent-total',
])('refuses rehashed %s coverage', async (kind) => {
  const { p, expected } = fixture();
  if (kind === 'missing-account') p.evidence.after.accounts.pop();
  if (kind === 'reordered-account') p.evidence.before.accounts.reverse();
  if (kind === 'extra-account')
    p.evidence.after.accounts.push(p.evidence.after.accounts[0]);
  if (kind === 'missing-mint') p.evidence.after.mints.pop();
  if (kind === 'reordered-mint') p.evidence.before.mints.reverse();
  if (kind === 'missing-rent-total') p.evidence.tokenAccountRents.pop();
  await reseal(p, expected);
  await expect(
    replayWarmupExecutionAssets(p, expected, signal()),
  ).rejects.toThrow('Retained warmup asset evidence');
});
it.each([-1, 1, 2])(
  'keeps ordinary Clock equality and refuses offset%s',
  async (offset) => {
    const { p, expected } = fixture();
    setClock(p, 'after', p.evidence.after.slot + offset);
    await reseal(p, expected);
    await expect(
      replayWarmupExecutionAssets(p, expected, signal()),
    ).rejects.toThrow('Retained warmup asset evidence');
  },
);
it.each([32, 33])('uses the original floor for a%s-slot span', async (span) => {
  const { p, expected } = fixture();
  p.evidence.after.slot = p.evidence.floorSlot + span;
  setClock(p, 'after', p.evidence.after.slot);
  await reseal(p, expected);
  const work = replayWarmupExecutionAssets(p, expected, signal());
  if (span === 32)
    expect((await work).evidence.after.slot).toBe(p.evidence.floorSlot + 32);
  else await expect(work).rejects.toThrow('Retained warmup asset evidence');
});
it.each([-31, -30, 30, 31])(
  'retains the historical30-second wall-time bound at%s seconds',
  async (offset) => {
    const { p, expected } = fixture();
    const at = Math.ceil(Date.parse(expected.reviewedAt) / 1000) * 1000;
    for (const side of ['before', 'after'] as const) {
      p.evidence[side].evaluatedServerAt = new Date(at).toISOString();
      p.evidence[side].unixTimestamp = String(at / 1000 + offset);
      setClock(p, side, undefined, BigInt(at / 1000 + offset));
    }
    p.evidence.checkedAt = new Date(at).toISOString();
    await reseal(p, expected);
    const work = replayWarmupExecutionAssets(p, expected, signal());
    if (Math.abs(offset) === 30)
      expect((await work).evidence.before.unixTimestamp).toBe(
        String(at / 1000 + offset),
      );
    else await expect(work).rejects.toThrow('Retained warmup asset evidence');
  },
);
it.each([
  'checked-at-expiry',
  'extended25s',
  'later-than-source',
  'reverse-observations',
  'before-review',
])('refuses %s historical chronology even with a new digest', async (kind) => {
  const { p, expected } = fixture();
  if (kind === 'checked-at-expiry') p.evidence.checkedAt = p.evidence.expiresAt;
  if (kind === 'extended25s') {
    p.evidence.expiresAt = new Date(
      Date.parse(p.evidence.before.evaluatedServerAt) + 25001,
    ).toISOString();
    expected.expiresAt = p.evidence.expiresAt;
  }
  if (kind === 'later-than-source')
    expected.reviewExpiresAt = p.evidence.checkedAt;
  if (kind === 'reverse-observations')
    p.evidence.after.evaluatedServerAt = new Date(
      Date.parse(p.evidence.before.evaluatedServerAt) - 1,
    ).toISOString();
  if (kind === 'before-review')
    expected.reviewedAt = new Date(
      Date.parse(p.evidence.before.evaluatedServerAt) + 1,
    ).toISOString();
  await reseal(p, expected);
  await expect(
    replayWarmupExecutionAssets(p, expected, signal()),
  ).rejects.toThrow('Retained warmup asset evidence');
});
it('accepts an incidental positive Rent balance change without mistaking it for a profile change', async () => {
  const { p, expected } = fixture();
  p.evidence.after.accounts.at(-1)!.account.lamports = '999';
  await reseal(p, expected);
  expect(
    (await replayWarmupExecutionAssets(p, expected, signal())).evidence.after
      .rent,
  ).toEqual(p.evidence.before.rent);
});
it('snapshots packet and selector before hashing and returns detached data', async () => {
  const { p, expected } = fixture();
  const work = replayWarmupExecutionAssets(p, expected, signal());
  p.evidence.after.accounts[1].account.data[0] = 'AA==';
  expected.ownerId = 'other-owner';
  expected.mints.reverse();
  const r = await work;
  expect(r.evidence).toEqual(original.evidence);
  r.evidence.after.accounts[1].account.data[0] = 'AA==';
  expect(original.evidence.after.accounts[1].account.data[0]).not.toBe('AA==');
});
it('preserves cancellation before replay and after the first asynchronous hash', async () => {
  const c = new AbortController();
  c.abort(new Error('cancelled replay'));
  await expect(
    replayWarmupExecutionAssets(original, selector, c.signal),
  ).rejects.toThrow('cancelled replay');
  const second = new AbortController(),
    originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  const hashing = vi
    .spyOn(crypto.subtle, 'digest')
    .mockImplementation(async (...args) => {
      const result = await originalDigest(...args);
      second.abort(new Error('cancelled hashing'));
      return result;
    });
  try {
    await expect(
      replayWarmupExecutionAssets(original, selector, second.signal),
    ).rejects.toThrow('cancelled hashing');
  } finally {
    hashing.mockRestore();
  }
});

it('preserves the original mint policy allowance for supply changes', async () => {
  const { p, expected } = fixture();
  const a = p.evidence.after.accounts[1].account;
  const bytes = Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
  new DataView(bytes.buffer).setBigUint64(36, 18446744073709551615n, true);
  a.data[0] = btoa(String.fromCharCode(...bytes));
  await reseal(p, expected);
  expect(
    (await replayWarmupExecutionAssets(p, expected, signal())).evidence.after
      .mints,
  ).toEqual(p.evidence.before.mints);
});

it('refuses a decreasing chain timestamp that would pass each individual wall-time bound', async () => {
  const { p, expected } = fixture();
  p.evidence.after.unixTimestamp = (
    BigInt(p.evidence.before.unixTimestamp) - 1n
  ).toString();
  setClock(p, 'after', undefined, BigInt(p.evidence.after.unixTimestamp));
  await reseal(p, expected);
  await expect(
    replayWarmupExecutionAssets(p, expected, signal()),
  ).rejects.toThrow('Retained warmup asset evidence');
});
it.each([false, true])(
  'requires identical Clock bytes at the same context slot (changed=%s)',
  async (changed) => {
    const { p, expected } = fixture();
    p.evidence.after.slot = p.evidence.before.slot;
    setClock(p, 'after', p.evidence.after.slot);
    if (changed) {
      const a = p.evidence.after.accounts.at(-2)!.account;
      const b = Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
      new DataView(b.buffer).setBigUint64(16, 1n, true);
      a.data[0] = btoa(String.fromCharCode(...b));
    }
    await reseal(p, expected);
    const work = replayWarmupExecutionAssets(p, expected, signal());
    if (changed)
      await expect(work).rejects.toThrow('Retained warmup asset evidence');
    else expect((await work).evidence.after.slot).toBe(p.evidence.before.slot);
  },
);
