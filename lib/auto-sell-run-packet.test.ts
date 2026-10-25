import { beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import {
  swapPreparationSummary,
  type SwapPreparationSummary,
} from './imported-swap-preparation-history';
import {
  AUTO_SELL_RUN_SUMMARY_MAX_BYTES,
  autoSellRunSummarySha256,
  readAutoSellRunPacketSummary,
  validateAutoSellRunPacket,
} from './auto-sell-run-packet';

let fixture: Awaited<ReturnType<typeof nativeWarmupFixture>>;
let lookupFixture: Awaited<ReturnType<typeof nativeWarmupFixture>>;
const otherWallet = '11111111111111111111111111111111';
function summary(source = fixture): SwapPreparationSummary {
  const balance = {
    executionAllowed: false,
    wallet: source.wallet,
    side: 'Sell',
    mint: source.mint,
    requestedRaw: source.order.inAmount,
    amountCovered: true,
    preparationSupported: true,
    source: 'fixture.invalid',
    observedAt: new Date().toISOString(),
    nativeSlot: 100,
  } as Parameters<typeof swapPreparationSummary>[2];
  return swapPreparationSummary(source.order, source.simulation, balance);
}
beforeAll(async () => {
  fixture = await nativeWarmupFixture({
    side: 'Sell',
    existing: true,
    v2: true,
  });
  lookupFixture = await nativeWarmupFixture({
    side: 'Sell',
    existing: true,
    v2: true,
    lookup: true,
  });
});
it('retains exact canonical unsigned packet identity without adding authority fields', async () => {
  const packet = await validateAutoSellRunPacket(
    fixture.order.preparation.transaction,
    summary(),
  );
  expect(packet).toEqual({
    transaction: fixture.order.preparation.transaction,
    sha256: fixture.order.preparation.sha256,
  });
  expect(Object.keys(packet)).toEqual(['transaction', 'sha256']);
});
it('validates packets with lookups against their exact retained lookup count without fetching them', async () => {
  const saved = summary(lookupFixture);
  expect(saved.transaction.lookupTableCount).toBeGreaterThan(0);
  await expect(
    validateAutoSellRunPacket(
      lookupFixture.order.preparation.transaction,
      saved,
    ),
  ).resolves.toEqual({
    transaction: lookupFixture.order.preparation.transaction,
    sha256: lookupFixture.order.preparation.sha256,
  });
});
it('admits historical expiry and refused or unavailable simulation observations without renewing them', async () => {
  const saved = summary();
  saved.expiresAt = '2020-01-01T00:00:00.000Z';
  saved.simulation.succeeded = false;
  saved.simulation.tokensComplete = false;
  saved.simulation.inputAmountMatches = null;
  saved.simulation.minimumOutputCovered = null;
  saved.simulation.routeStatus = 'Unavailable';
  saved.simulation.bindingStatus = 'Unavailable';
  await expect(
    validateAutoSellRunPacket(fixture.order.preparation.transaction, saved),
  ).resolves.toHaveProperty('sha256', fixture.order.preparation.sha256);
  expect(saved.expiresAt).toBe('2020-01-01T00:00:00.000Z');
});
it('retains structurally valid quote fee metadata without treating it as an approved signing fee', async () => {
  const saved = summary();
  saved.platformFee = { bps: 100, mint: saved.outputMint };
  await expect(
    validateAutoSellRunPacket(fixture.order.preparation.transaction, saved),
  ).resolves.toHaveProperty('sha256');
  expect(readAutoSellRunPacketSummary(saved).executionAllowed).toBe(false);
});
it('detaches all summary descriptors before its asynchronous packet digest', async () => {
  const saved = summary();
  const original = saved.transaction.sha256;
  const pending = validateAutoSellRunPacket(
    fixture.order.preparation.transaction,
    saved,
  );
  saved.wallet = otherWallet;
  saved.transaction.sha256 = 'a'.repeat(64);
  saved.simulation.source = 'mutated after capture';
  await expect(pending).resolves.toHaveProperty('sha256', original);
});
it.each([
  [
    'hash',
    (saved: SwapPreparationSummary) => {
      saved.transaction.sha256 = 'a'.repeat(64);
    },
  ],
  [
    'wallet',
    (saved: SwapPreparationSummary) => {
      saved.wallet = otherWallet;
    },
  ],
  [
    'bytes',
    (saved: SwapPreparationSummary) => {
      saved.transaction.bytes++;
    },
  ],
  [
    'instruction count',
    (saved: SwapPreparationSummary) => {
      saved.transaction.instructionCount++;
    },
  ],
  [
    'lookup count',
    (saved: SwapPreparationSummary) => {
      saved.transaction.lookupTableCount++;
    },
  ],
] as const)('refuses changed %s envelope evidence', async (_name, mutate) => {
  const saved = summary();
  mutate(saved);
  await expect(
    validateAutoSellRunPacket(fixture.order.preparation.transaction, saved),
  ).rejects.toThrow('retained unsigned');
});
it.each(['not base64', '', 'A'.repeat(1648), 'AAAA', 'AA== ', null, 12])(
  'refuses malformed transaction input %s',
  async (transaction) => {
    await expect(
      validateAutoSellRunPacket(transaction, summary()),
    ).rejects.toThrow('retained unsigned');
  },
);
it('refuses an already signed packet even when metadata retains its signed hash', async () => {
  const saved = summary();
  saved.transaction.sha256 = createHash('sha256')
    .update(Buffer.from(fixture.signed.transaction, 'base64'))
    .digest('hex');
  await expect(
    validateAutoSellRunPacket(fixture.signed.transaction, saved),
  ).rejects.toThrow('retained unsigned');
});
it('refuses altered packet bytes against the original retained summary hash', async () => {
  const bytes = Buffer.from(fixture.order.preparation.transaction, 'base64');
  bytes[bytes.length - 1] ^= 1;
  await expect(
    validateAutoSellRunPacket(bytes.toString('base64'), summary()),
  ).rejects.toThrow('retained unsigned');
});
it('refuses decoded packets above1232bytes even when canonical base64 fits1644characters', async () => {
  const oversized = Buffer.alloc(1233).toString('base64');
  expect(oversized).toHaveLength(1644);
  await expect(validateAutoSellRunPacket(oversized, summary())).rejects.toThrow(
    'retained unsigned',
  );
});
it('accepts an older serialized summary without an optional native slot', async () => {
  const saved = summary();
  const parsed = JSON.parse(
    JSON.stringify({
      ...saved,
      balance: {
        source: saved.balance.source,
        observedAt: saved.balance.observedAt,
        requestedRaw: saved.balance.requestedRaw,
        amountCovered: saved.balance.amountCovered,
      },
    }),
  ) as SwapPreparationSummary;
  expect(Object.hasOwn(parsed.balance, 'nativeSlot')).toBe(false);
  await expect(
    validateAutoSellRunPacket(fixture.order.preparation.transaction, parsed),
  ).resolves.toHaveProperty('sha256', fixture.order.preparation.sha256);
});
it.each([
  'executionAllowed',
  'instructionsVerified',
  'side',
  'acquisition',
  'conditional',
  'session',
  'unknown',
  'symbol',
  'hidden',
  'prototype',
  'nested-accessor',
  'root-accessor',
  'toJSON',
  'invalid-unicode',
  'too-large',
  'wrong-output',
] as const)(
  'refuses a noncanonical %s summary without invoking accessors',
  async (fault) => {
    const saved = summary() as unknown as Record<PropertyKey, unknown>;
    let invoked = 0;
    if (fault === 'executionAllowed' || fault === 'instructionsVerified')
      saved[fault] = true;
    if (fault === 'side') saved.side = 'Buy';
    if (['acquisition', 'conditional', 'session', 'unknown'].includes(fault))
      saved[fault] = {};
    if (fault === 'symbol') saved[Symbol('hidden')] = false;
    if (fault === 'hidden')
      Object.defineProperty(saved, 'extra', {
        value: false,
        enumerable: false,
      });
    if (fault === 'prototype') Object.setPrototypeOf(saved, { hidden: true });
    if (fault === 'root-accessor')
      Object.defineProperty(saved, 'wallet', {
        enumerable: true,
        get() {
          invoked++;
          return fixture.wallet;
        },
      });
    if (fault === 'nested-accessor')
      Object.defineProperty(saved.transaction, 'sha256', {
        enumerable: true,
        get() {
          invoked++;
          return fixture.order.preparation.sha256;
        },
      });
    if (fault === 'toJSON')
      saved.toJSON = () => {
        invoked++;
        return {};
      };
    if (fault === 'invalid-unicode') saved.limitations = '\ud800';
    if (fault === 'too-large')
      saved.limitations = 'x'.repeat(AUTO_SELL_RUN_SUMMARY_MAX_BYTES + 1);
    if (fault === 'wrong-output') saved.outputMint = fixture.mint;
    await expect(
      validateAutoSellRunPacket(
        fixture.order.preparation.transaction,
        saved as unknown as SwapPreparationSummary,
      ),
    ).rejects.toThrow('retained unsigned');
    expect(invoked).toBe(0);
  },
);
it('binds exact original summary JSON bytes with a domain-separated SHA256', async () => {
  const raw = JSON.stringify(summary());
  const digest = createHash('sha256')
    .update(JSON.stringify(['auto-sell-run-summary-v1', raw]), 'utf8')
    .digest('hex');
  await expect(autoSellRunSummarySha256(raw)).resolves.toBe(digest);
  const changed = JSON.parse(raw) as SwapPreparationSummary;
  changed.simulation.source = 'another source';
  expect(await autoSellRunSummarySha256(JSON.stringify(changed))).not.toBe(
    digest,
  );
});
it.each([
  'whitespace',
  'duplicate',
  'escape',
  'invalid-json',
  'oversize',
] as const)(
  'refuses %s raw summary serialization rather than silently normalizing it',
  async (fault) => {
    const raw = JSON.stringify(summary());
    const text =
      fault === 'whitespace'
        ? ' ' + raw
        : fault === 'duplicate'
          ? raw.replace('"side":"Sell"', '"side":"Buy","side":"Sell"')
          : fault === 'escape'
            ? raw.replace('"Sell"', '"\\u0053ell"')
            : fault === 'invalid-json'
              ? 'PRIVATE not JSON'
              : 'x'.repeat(AUTO_SELL_RUN_SUMMARY_MAX_BYTES + 1);
    await expect(autoSellRunSummarySha256(text)).rejects.toThrow(
      'retained unsigned',
    );
  },
);
it('accepts null-prototype JSON records after detaching them and keeps nested copies independent', () => {
  const saved = summary();
  const value = Object.assign(
    Object.create(null),
    saved,
  ) as SwapPreparationSummary;
  const copy = readAutoSellRunPacketSummary(value);
  expect(copy).toEqual(saved);
  expect(copy).not.toBe(value);
  expect(copy.transaction).not.toBe(value.transaction);
});
