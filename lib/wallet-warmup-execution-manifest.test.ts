import { expect, it } from 'vitest';
import {
  executionManifest,
  executionHash,
  executionId,
  executionNow,
} from '../test/warmup-execution-ledger-fixture';
import {
  bindWarmupExecutionManifest,
  parseWarmupExecutionManifest,
} from './wallet-warmup-execution-manifest';
import { WARMUP_V2_POLICY } from './wallet-warmup-session-v2-consent';
import {
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';

it('binds policy and owner/consent identity and retains the existing pacing rules', async () => {
  const m = executionManifest(),
    original = await bindWarmupExecutionManifest(m);
  expect(m.policy).toMatchObject(WARMUP_V2_POLICY);
  m.ownerId = 'another-owner';
  expect((await bindWarmupExecutionManifest(m)).sha256).not.toBe(
    original.sha256,
  );
  m.consentId = executionId(123);
  expect((await bindWarmupExecutionManifest(m)).sha256).not.toBe(
    original.sha256,
  );
  Object.assign(m.policy, { minimumGapMs: 15000 });
  expect(() => parseWarmupExecutionManifest(m)).toThrow();
});
it('refuses schedule extensions, impossible pacing and inconsistent token metadata across unrelated pairs', () => {
  const m = executionManifest();
  m.expiresAt = new Date(executionNow + 300001).toISOString();
  expect(() => parseWarmupExecutionManifest(m)).toThrow();
  m.expiresAt = new Date(executionNow + 30000).toISOString();
  expect(() => parseWarmupExecutionManifest(m)).toThrow();
  m.expiresAt = new Date(executionNow + 180000).toISOString();
  const buy = m.actions[0],
    sell = m.actions[1];
  m.wallets[0].maximumBuyLamports = '200';
  m.wallets[0].maximumFeeRentLamports = '40';
  m.actions.push({
    ...buy,
    side: 'Buy',
    id: 'other-buy',
    tokenProgram: SWAP_TOKEN_2022,
    inputLamports: '100',
  });
  m.actions.push({
    ...sell,
    side: 'Sell',
    id: 'other-sell',
    tokenProgram: SWAP_TOKEN_2022,
    source: { kind: 'action-buy', actionId: 'other-buy' },
  });
  expect(() => parseWarmupExecutionManifest(m)).toThrow();
});
it('refuses a native SOL mint even when both paired actions agree', () => {
  const m = executionManifest();
  m.actions.forEach((a) => {
    a.mint = SWAP_WRAPPED_SOL;
  });
  expect(() => parseWarmupExecutionManifest(m)).toThrow();
});

it('binds the distinct manifest, original expiry, source, consent and exact raw caps', async () => {
  const m = executionManifest();
  const first = await bindWarmupExecutionManifest(m);
  const second = await bindWarmupExecutionManifest(
    JSON.parse(JSON.stringify(m)),
  );
  expect(second).toEqual(first);
  m.consentSha256 = executionHash(8);
  expect((await bindWarmupExecutionManifest(m)).sha256).not.toBe(first.sha256);
  expect(first.manifest.consentSha256).toBe(executionHash(2));
});
it.each([
  (m: ReturnType<typeof executionManifest>) => {
    Object.assign(m, { format: 'wallet-warmup-session-consent-v2' });
  },
  (m: ReturnType<typeof executionManifest>) => {
    Object.assign(m, { executionAllowed: true });
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.wallets.push({ ...m.wallets[0] });
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.wallets[0].maximumBuyLamports = '99';
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.wallets[0].maximumFeeRentLamports = '19';
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.wallets[0].maximumBuyLamports = '18446744073709551615';
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.actions[1].id = 'buy';
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.actions[1].mint = m.wallets[0].wallet;
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.actions[1].decimals = 9;
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.actions.reverse();
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.actions.pop();
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.actions.push({ ...m.actions[1], id: 'duplicate-source' });
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.actions[0].scheduledAt = m.expiresAt;
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.expiresAt = m.createdAt;
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.actions[0].scheduledAt = new Date(executionNow - 1).toISOString();
  },
  (m: ReturnType<typeof executionManifest>) => {
    m.savedLots.push({
      receiptId: executionId(50),
      wallet: m.wallets[0].wallet,
      mint: m.actions[0].mint,
      tokenProgram: m.actions[0].tokenProgram,
      decimals: 6,
      remainingRaw: '1',
      sourceSha256: executionHash(5),
    });
  },
])('refuses a changed or impossible manifest (%#)', (change) => {
  const m = executionManifest();
  change(m);
  expect(() => parseWarmupExecutionManifest(m)).toThrow();
});
it.each(['-1', '01', '1.0', '18446744073709551616', '', '1e3'])(
  'refuses noncanonical or overflowing raw units %s',
  (raw) => {
    const m = executionManifest();
    m.actions[0].maximumFeeRentLamports = raw;
    expect(() => parseWarmupExecutionManifest(m)).toThrow();
  },
);
it('binds a saved lot exactly and refuses wrong owner-wallet or duplicate provenance', () => {
  const m = executionManifest();
  m.actions = [
    {
      ...m.actions[1],
      side: 'Sell',
      source: { kind: 'saved-buy', receiptId: executionId(50) },
    },
  ];
  m.savedLots = [
    {
      receiptId: executionId(50),
      wallet: m.wallets[0].wallet,
      mint: m.actions[0].mint,
      tokenProgram: m.actions[0].tokenProgram,
      decimals: 6,
      remainingRaw: '9',
      sourceSha256: executionHash(9),
    },
  ];
  expect(parseWarmupExecutionManifest(m).savedLots[0].remainingRaw).toBe('9');
  m.savedLots[0].wallet = m.actions[0].mint;
  expect(() => parseWarmupExecutionManifest(m)).toThrow();
});
