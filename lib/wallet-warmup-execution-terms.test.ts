import { expect, it, vi } from 'vitest';
import {
  executionManifest,
  executionId,
  executionHash,
  executionNow,
} from '../test/warmup-execution-ledger-fixture';
import { executionCapacityManifest } from '../test/warmup-execution-capacity-fixture';
import {
  parseWarmupExecutionManifest,
  parseWarmupExecutionIntent,
  type WarmupExecutionManifest,
} from './wallet-warmup-execution-manifest';
import {
  bindWarmupExecutionTerms,
  bindWarmupExecutionRoot,
  readWarmupExecutionRootBinding,
  WARMUP_EXECUTION_ACKNOWLEDGEMENT,
  type WarmupExecutionTerms,
  type WarmupExecutionApproval,
} from './wallet-warmup-execution-terms';
import { WarmupExecutionLedger } from './wallet-warmup-execution-ledger';

function terms(
  manifest: WarmupExecutionManifest = executionManifest(),
): WarmupExecutionTerms {
  const { format: _format, consentSha256: _consentSha256, ...body } = manifest;
  return {
    format: 'wallet-warmup-execution-terms-v1',
    intent: { ...body, format: 'wallet-warmup-execution-intent-v1' },
    review: {
      id: executionId(50),
      sha256: executionHash(50),
      reviewedAt: body.createdAt,
      reviewExpiresAt: new Date(
        Date.parse(body.createdAt) + 60000,
      ).toISOString(),
    },
    verifierEvidenceSha256: executionHash(51),
  };
}
async function approval(value = terms()): Promise<WarmupExecutionApproval> {
  return {
    format: 'wallet-warmup-execution-approval-v1',
    id: value.intent.consentId,
    rootId: value.intent.id,
    ownerId: value.intent.ownerId,
    reviewId: value.review.id,
    termsSha256: (await bindWarmupExecutionTerms(value)).termsSha256,
    approvedAt: new Date(
      Date.parse(value.review.reviewedAt) + 1000,
    ).toISOString(),
    sessionExpiresAt: value.intent.expiresAt,
    acknowledgement: WARMUP_EXECUTION_ACKNOWLEDGEMENT,
  };
}
async function fixture(value = terms()) {
  const agreed = await approval(value);
  const bound = await bindWarmupExecutionRoot(value, agreed);
  const expected = {
    id: value.intent.id,
    ownerId: value.intent.ownerId,
    consentId: value.intent.consentId,
    reviewId: value.review.id,
    rootSha256: bound.rootSha256,
  };
  return { value, agreed, bound, expected };
}

it('binds complete intent -> terms -> approval -> root with separate manifest identity and no authority', async () => {
  const f = await fixture();
  expect(f.bound.root.termsSha256).toBe(f.agreed.termsSha256);
  expect(f.bound.manifest.consentSha256).toBe(f.bound.root.consentSha256);
  expect(f.bound.manifest).toEqual({
    ...f.value.intent,
    format: 'wallet-warmup-execution-manifest-v1',
    consentSha256: f.bound.root.consentSha256,
  });
  expect(
    new Set([
      f.bound.rootSha256,
      f.bound.root.termsSha256,
      f.bound.root.consentSha256,
      f.bound.manifestSha256,
    ]).size,
  ).toBe(4);
  expect(f.bound.manifest.consentSha256).not.toBe(
    executionManifest().consentSha256,
  );
  expect(f.bound).toMatchObject({
    scope: 'execution-bookkeeping-model-only',
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(
    await readWarmupExecutionRootBinding(f.bound.root, f.agreed, f.expected),
  ).toEqual(f.bound);
});

it('refuses a placeholder consent hash or manifest domain on pre-consent intent', () => {
  const value = terms();
  expect(() =>
    parseWarmupExecutionIntent({
      ...value.intent,
      consentSha256: executionHash(0),
    }),
  ).toThrow();
  expect(() => parseWarmupExecutionIntent(executionManifest())).toThrow();
  expect(() => parseWarmupExecutionManifest(value.intent)).toThrow();
});

it('keeps the existing ledger digest in the manifest domain rather than substituting the new root hash', async () => {
  const f = await fixture();
  const ledger = await WarmupExecutionLedger.create(f.bound.manifest);
  expect(ledger.snapshot().rootSha256).toBe(f.bound.manifestSha256);
  expect(() =>
    ledger.apply({
      operation: 'reserve',
      expectedVersion: 0,
      now: executionNow,
      expectedRootSha256: f.bound.rootSha256,
    }),
  ).toThrow();
  expect(ledger.snapshot().version).toBe(0);
  expect(ledger.snapshot().executionAllowed).toBe(false);
});

it('keeps the same economics, exact asset, dependency and pacing checks before consent', () => {
  for (const mutate of [
    (v: WarmupExecutionTerms) => {
      v.intent.wallets[0].maximumBuyLamports = '99';
    },
    (v: WarmupExecutionTerms) => {
      v.intent.wallets[0].maximumFeeRentLamports = '19';
    },
    (v: WarmupExecutionTerms) => {
      v.intent.actions[1].decimals = 7;
    },
    (v: WarmupExecutionTerms) => {
      v.intent.actions.pop();
    },
    (v: WarmupExecutionTerms) => {
      v.intent.expiresAt = new Date(executionNow + 30000).toISOString();
    },
  ]) {
    const value = terms();
    mutate(value);
    expect(() => parseWarmupExecutionIntent(value.intent)).toThrow();
  }
});

it.each([
  'wallet-warmup-session-consent-v1',
  'wallet-warmup-session-consent-v2',
])('never upgrades legacy approval %s', async (format) => {
  const value = terms();
  await expect(
    bindWarmupExecutionRoot(value, { ...(await approval(value)), format }),
  ).rejects.toThrow();
});

it.each(['', true, false, 'I approve', undefined])(
  'requires the exact separate acknowledgement (%s)',
  async (acknowledgement) => {
    const value = terms();
    await expect(
      bindWarmupExecutionRoot(value, {
        ...(await approval(value)),
        acknowledgement,
      }),
    ).rejects.toThrow();
  },
);

it.each([
  'id',
  'rootId',
  'ownerId',
  'reviewId',
  'termsSha256',
  'sessionExpiresAt',
] as const)('refuses a changed approval %s', async (key) => {
  const value = terms();
  const agreed = await approval(value);
  const changed =
    key === 'ownerId'
      ? 'another-owner'
      : key === 'termsSha256'
        ? executionHash(999)
        : key === 'sessionExpiresAt'
          ? new Date(executionNow + 180001).toISOString()
          : executionId(999);
  await expect(
    bindWarmupExecutionRoot(value, { ...agreed, [key]: changed }),
  ).rejects.toThrow();
});

it.each([
  [-1, false],
  [0, true],
  [59999, true],
  [60000, false],
])(
  'keeps original review approval boundary at %i ms',
  async (offset, allowed) => {
    const value = terms();
    const agreed = {
      ...(await approval(value)),
      approvedAt: new Date(executionNow + offset).toISOString(),
    };
    const result = bindWarmupExecutionRoot(value, agreed);
    if (allowed)
      expect((await result).approval.approvedAt).toBe(agreed.approvedAt);
    else await expect(result).rejects.toThrow();
  },
);

it('refuses approval exactly at the original session expiry even with a later review expiry', async () => {
  const value = terms();
  value.intent.expiresAt = new Date(executionNow + 45000).toISOString();
  await expect(
    bindWarmupExecutionRoot(value, {
      ...(await approval(value)),
      approvedAt: value.intent.expiresAt,
    }),
  ).rejects.toThrow();
});

it('does not extend the review lifetime or detach it from original manifest creation', async () => {
  const value = terms();
  value.review.reviewExpiresAt = new Date(executionNow + 60001).toISOString();
  await expect(bindWarmupExecutionTerms(value)).rejects.toThrow();
  const moved = terms();
  moved.review.reviewedAt = new Date(executionNow + 1).toISOString();
  moved.review.reviewExpiresAt = new Date(executionNow + 60001).toISOString();
  await expect(bindWarmupExecutionTerms(moved)).rejects.toThrow();
});

it('preserves a shorter recorded review window instead of replacing it with a full minute', async () => {
  const value = terms();
  value.review.reviewExpiresAt = new Date(executionNow + 30000).toISOString();
  const agreed = await approval(value);
  expect(
    (await bindWarmupExecutionRoot(value, agreed)).root.terms.review
      .reviewExpiresAt,
  ).toBe(value.review.reviewExpiresAt);
  await expect(
    bindWarmupExecutionRoot(value, {
      ...agreed,
      approvedAt: value.review.reviewExpiresAt,
    }),
  ).rejects.toThrow();
  value.review.reviewExpiresAt = value.review.reviewedAt;
  await expect(bindWarmupExecutionTerms(value)).rejects.toThrow();
});

it('refuses a changed review timestamp alone', async () => {
  const value = terms();
  value.review.reviewedAt = new Date(executionNow + 1).toISOString();
  await expect(bindWarmupExecutionTerms(value)).rejects.toThrow();
});

it.each(['root-consent', 'root-review', 'consent-review'])(
  'requires distinct identities (%s)',
  async (kind) => {
    const value = terms();
    if (kind === 'root-consent') value.intent.consentId = value.intent.id;
    else
      value.review.id =
        kind === 'root-review' ? value.intent.id : value.intent.consentId;
    await expect(bindWarmupExecutionTerms(value)).rejects.toThrow();
  },
);

it('refuses a schedule that fit at review time but no longer fits at its recorded approval time', async () => {
  const value = terms();
  value.intent.expiresAt = new Date(executionNow + 30001).toISOString();
  const agreed = await approval(value);
  expect((await bindWarmupExecutionTerms(value)).terms.intent.expiresAt).toBe(
    value.intent.expiresAt,
  );
  await expect(bindWarmupExecutionRoot(value, agreed)).rejects.toThrow();
  const exact = await bindWarmupExecutionRoot(value, {
    ...agreed,
    approvedAt: value.review.reviewedAt,
  });
  expect(exact.root.terms.intent.expiresAt).toBe(value.intent.expiresAt);
});

it('revalidates mutable returned root contents before accepting their old digest', async () => {
  const f = await fixture();
  f.bound.root.terms.verifierEvidenceSha256 = executionHash(99);
  await expect(
    readWarmupExecutionRootBinding(f.bound.root, f.agreed, f.expected),
  ).rejects.toThrow();
});

it('captures both input objects before awaiting and detaches the flat manifest from root terms', async () => {
  const value = terms();
  const agreed = await approval(value);
  const pending = bindWarmupExecutionRoot(value, agreed);
  value.intent.actions[0].id = 'mutated';
  agreed.ownerId = 'mutated';
  const bound = await pending;
  expect(bound.manifest.actions[0].id).toBe('buy');
  expect(bound.approval.ownerId).toBe('synthetic-owner');
  bound.manifest.actions[0].id = 'changed-returned-manifest';
  expect(bound.root.terms.intent.actions[0].id).toBe('buy');
});

it('captures the expected selector before awaiting and never derives it from a root', async () => {
  const f = await fixture();
  const pending = readWarmupExecutionRootBinding(
    f.bound.root,
    f.agreed,
    f.expected,
  );
  f.expected.ownerId = 'changed';
  f.bound.root.terms.intent.ownerId = 'changed';
  f.agreed.ownerId = 'changed';
  expect((await pending).root.terms.intent.ownerId).toBe('synthetic-owner');
});

it.each(['id', 'ownerId', 'consentId', 'reviewId', 'rootSha256'] as const)(
  'requires independently expected %s',
  async (key) => {
    const f = await fixture();
    const changed =
      key === 'ownerId'
        ? 'other-owner'
        : key === 'rootSha256'
          ? f.bound.manifestSha256
          : executionId(999);
    await expect(
      readWarmupExecutionRootBinding(f.bound.root, f.agreed, {
        ...f.expected,
        [key]: changed,
      }),
    ).rejects.toThrow();
  },
);

it('refuses root and consent hash replacement, not just malformed fields', async () => {
  const f = await fixture();
  for (const key of ['termsSha256', 'consentSha256'] as const) {
    await expect(
      readWarmupExecutionRootBinding(
        { ...f.bound.root, [key]: executionHash(999) },
        f.agreed,
        f.expected,
      ),
    ).rejects.toThrow();
  }
  const changed = structuredClone(f.value);
  changed.intent.actions[0].maximumFeeRentLamports = '9';
  const rebound = await bindWarmupExecutionRoot(
    changed,
    await approval(changed),
  );
  await expect(
    readWarmupExecutionRootBinding(rebound.root, rebound.approval, f.expected),
  ).rejects.toThrow();
});

it('refuses a different otherwise-valid recorded approval time during expected-root recovery', async () => {
  const f = await fixture();
  await expect(
    readWarmupExecutionRootBinding(
      f.bound.root,
      {
        ...f.agreed,
        approvedAt: new Date(executionNow + 2000).toISOString(),
      },
      f.expected,
    ),
  ).rejects.toThrow();
});

it.each(['sourceSha256', 'planId', 'planRevision', 'expiresAt'] as const)(
  'does not reuse approval after changing intent %s',
  async (key) => {
    const f = await fixture();
    const changed = structuredClone(f.value);
    if (key === 'sourceSha256') changed.intent.sourceSha256 = executionHash(99);
    if (key === 'planId') changed.intent.planId = 'another-plan';
    if (key === 'planRevision') changed.intent.planRevision++;
    if (key === 'expiresAt')
      changed.intent.expiresAt = new Date(executionNow + 179999).toISOString();
    await expect(bindWarmupExecutionRoot(changed, f.agreed)).rejects.toThrow();
  },
);

it('binds review and verifier source references instead of ignoring extra semantics', async () => {
  const f = await fixture();
  for (const key of ['review', 'verifierEvidenceSha256'] as const) {
    const changed = structuredClone(f.value);
    if (key === 'review') changed.review.sha256 = executionHash(99);
    else changed.verifierEvidenceSha256 = executionHash(99);
    await expect(bindWarmupExecutionRoot(changed, f.agreed)).rejects.toThrow();
  }
  await expect(
    bindWarmupExecutionTerms({ ...f.value, consentSha256: executionHash(0) }),
  ).rejects.toThrow();
  await expect(
    readWarmupExecutionRootBinding(
      { ...f.bound.root, signingAllowed: true },
      f.agreed,
      f.expected,
    ),
  ).rejects.toThrow();
});

it('recovers the same historical hashes without renewing expiry or granting permission', async () => {
  const f = await fixture();
  const now = vi
    .spyOn(Date, 'now')
    .mockReturnValue(executionNow + 365 * 86400000);
  try {
    const result = await readWarmupExecutionRootBinding(
      f.bound.root,
      f.agreed,
      f.expected,
    );
    expect(result).toEqual(f.bound);
    expect(result.root.terms.intent.expiresAt).toBe(
      new Date(executionNow + 180000).toISOString(),
    );
    expect(now).not.toHaveBeenCalled();
    expect(result.executionAllowed).toBe(false);
  } finally {
    now.mockRestore();
  }
});

function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, v]) => [key, reversed(v)]),
    );
  return value;
}
it('canonicalizes object key order without changing action order', async () => {
  const f = await fixture();
  expect(
    await bindWarmupExecutionRoot(reversed(f.value), reversed(f.agreed)),
  ).toEqual(f.bound);
  const changed = structuredClone(f.value);
  changed.intent.actions.reverse();
  await expect(bindWarmupExecutionRoot(changed, f.agreed)).rejects.toThrow();
});

it('preserves every action and saved lot at 4800-action model capacity', async () => {
  const manifest = executionCapacityManifest('mixed');
  const f = await fixture(terms(manifest));
  expect(f.bound.manifest.actions).toHaveLength(4800);
  expect(f.bound.root.terms.intent.actions).toEqual(manifest.actions);
  expect(f.bound.manifest.savedLots).toEqual(manifest.savedLots);
  expect(
    (await readWarmupExecutionRootBinding(f.bound.root, f.agreed, f.expected))
      .manifestSha256,
  ).toBe(f.bound.manifestSha256);
});
