import { expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { bundleFingerprint, type JitoBundleManifest } from './jito-bundle';
import {
  JITO_SEQUENTIAL_CHECK_AUTHORITY,
  requireJitoSequentialCheckResult as requireResult,
  type JitoSequentialCheckResult,
} from './jito-sequential-check-result';
function diagnostic(manifest: JitoBundleManifest): JitoSequentialCheckResult {
  return {
    format: 'jito-sequential-check-v1',
    bundleId: manifest.id,
    manifestSha256: manifest.sha256,
    expiresAt: manifest.expiresAt,
    observedAt: manifest.createdAt,
    status: 'frames-observed',
    reason: 'frame-integrity-only',
    packetCount: manifest.swaps.length + 1,
    minimumSlot: 100,
    simulationSlot: 101,
    fees: [
      ...manifest.swaps.map((s, packet) => ({
        packet,
        feeLamports: s.maximumFeeLamports,
        slot: 101,
      })),
      {
        packet: manifest.swaps.length,
        feeLamports: manifest.tip.feeLamports,
        slot: 101,
      },
    ],
    ...JITO_SEQUENTIAL_CHECK_AUTHORITY,
  };
}
async function refusal(
  change: (
    value: Record<string, unknown>,
    manifest: JitoBundleManifest,
  ) => void,
) {
  const { manifest } = await jitoBundleFixture();
  const value = diagnostic(manifest);
  change(value, manifest);
  expect(() => requireResult(value, manifest)).toThrow();
}
for (const wallets of [1, 4])
  it(`binds an exact ${wallets + 1}-packet public diagnostic without changing manifest or signing authority`, async () => {
    const { manifest } = await jitoBundleFixture(wallets);
    const value = diagnostic(manifest),
      before = structuredClone(value),
      original = structuredClone(manifest);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Error('network forbidden'));
    try {
      expect(requireResult(value, manifest)).toBe(value);
      expect(value).toEqual(before);
      expect(manifest).toEqual(original);
      expect(network).not.toHaveBeenCalled();
      for (const flag of Object.keys(JITO_SEQUENTIAL_CHECK_AUTHORITY))
        expect((value as unknown as Record<string, unknown>)[flag]).toBe(false);
    } finally {
      network.mockRestore();
    }
  });
for (const field of [
  'format',
  'bundleId',
  'manifestSha256',
  'expiresAt',
  'packetCount',
])
  it(`refuses another ${field} rather than accepting a diagnostic for another saved bundle`, async () =>
    refusal((value) => {
      value[field] =
        field === 'packetCount'
          ? 3
          : field === 'format'
            ? 'another-format'
            : field === 'manifestSha256'
              ? 'a'.repeat(64)
              : field === 'expiresAt'
                ? '2099-01-01T00:00:00.000Z'
                : crypto.randomUUID();
    }));
it('rejects private raw/provider payloads and replacement combined-key fields', async () => {
  for (const field of [
    'rawBody',
    'rawResponse',
    'transaction',
    'providerUrl',
    'unexpected',
  ])
    await refusal((value) => {
      value[field] = 'private data';
    });
  await refusal((value) => {
    delete value.bundleId;
    value['bundleId,manifestSha256'] = 'combined';
  });
  await refusal((value) => {
    const fees = value.fees as Record<string, unknown>[];
    fees[0].rawResponse = 'private data';
  });
});
for (const flag of Object.keys(JITO_SEQUENTIAL_CHECK_AUTHORITY))
  it(`requires ${flag} to remain exactly false`, async () => {
    for (const bad of [true, 0, 'false', null, undefined, []])
      await refusal((value) => {
        value[flag] = bad;
      });
  });
it('refuses missing authority fields rather than treating absence as false', async () => {
  const { manifest } = await jitoBundleFixture();
  for (const flag of Object.keys(JITO_SEQUENTIAL_CHECK_AUTHORITY)) {
    const value = diagnostic(manifest) as unknown as Record<string, unknown>;
    delete value[flag];
    expect(() => requireResult(value, manifest)).toThrow();
  }
});
it('requires canonical ISO observation time inside the original saved lifetime', async () => {
  const { manifest } = await jitoBundleFixture();
  for (const observedAt of [
    'invalid',
    new Date(Date.parse(manifest.createdAt) - 1).toISOString(),
    manifest.expiresAt,
    new Date(Date.parse(manifest.expiresAt) + 1).toISOString(),
    manifest.createdAt.replace('Z', '+00:00'),
  ])
    expect(() =>
      requireResult({ ...diagnostic(manifest), observedAt }, manifest),
    ).toThrow();
  const last = new Date(Date.parse(manifest.expiresAt) - 1).toISOString();
  expect(
    requireResult({ ...diagnostic(manifest), observedAt: last }, manifest)
      .observedAt,
  ).toBe(last);
});
it('accepts refused empty/partial observations without upgrading them to a coherent simulation result', async () => {
  const { manifest } = await jitoBundleFixture(4),
    base = diagnostic(manifest);
  for (const fees of [[], base.fees.slice(0, 2)]) {
    const value = {
      ...base,
      status: 'refused' as const,
      reason: 'fees-refused' as const,
      simulationSlot: null,
      fees,
    };
    expect(requireResult(value, manifest)).toBe(value);
    expect(value.status).toBe('refused');
    expect(value.signingAllowed).toBe(false);
  }
  const unavailable = {
    ...base,
    status: 'refused' as const,
    reason: 'bank-unavailable' as const,
  };
  expect(requireResult(unavailable, manifest).reason).toBe('bank-unavailable');
});
it('requires observed frames to carry the complete ordered coherent fee vector and its reason', async () => {
  await refusal((value) => {
    value.reason = 'bank-unavailable';
  });
  await refusal((value) => {
    value.simulationSlot = null;
  });
  await refusal((value) => {
    (value.fees as unknown[]).pop();
  });
  await refusal((value) => {
    (value.fees as { slot: number }[])[0].slot = 102;
  });
  await refusal((value) => {
    (value.fees as unknown[]).reverse();
  });
  await refusal((value) => {
    value.status = 'refused';
  });
});
it('refuses unknown or coerced statuses and reasons', async () => {
  for (const status of [
    'observed',
    'signed',
    'submitted',
    1,
    null,
    ['refused'],
  ])
    await refusal((value) => {
      value.status = status;
      value.reason = 'bank-unavailable';
      value.simulationSlot = null;
      value.fees = [];
    });
  for (const reason of ['', 'approved', 'provider says safe', 1, [], null])
    await refusal((value) => {
      value.reason = reason;
    });
});
it('enforces safe integer slot types and the unchanged inclusive 32-slot span', async () => {
  const { manifest } = await jitoBundleFixture();
  const boundary = {
    ...diagnostic(manifest),
    minimumSlot: 100,
    simulationSlot: 132,
    fees: diagnostic(manifest).fees.map((f) => ({ ...f, slot: 132 })),
  };
  expect(requireResult(boundary, manifest).simulationSlot).toBe(132);
  for (const field of ['minimumSlot', 'simulationSlot'] as const)
    for (const invalid of [
      -1,
      NaN,
      Infinity,
      100.5,
      Number.MAX_SAFE_INTEGER + 1,
      '100',
    ])
      expect(() =>
        requireResult({ ...diagnostic(manifest), [field]: invalid }, manifest),
      ).toThrow();
  await refusal((value) => {
    value.simulationSlot = 99;
  });
  await refusal((value) => {
    value.simulationSlot = 133;
  });
  for (const invalid of [
    99,
    133,
    -1,
    100.5,
    Number.MAX_SAFE_INTEGER + 1,
    '101',
  ])
    await refusal((value) => {
      (value.fees as Record<string, unknown>[])[0].slot = invalid;
    });
});
for (const fee of [
  '0',
  '-1',
  '05000',
  '5e3',
  '5000.0',
  '18446744073709551616',
  5000,
  5000n,
  null,
])
  it(`refuses noncanonical/nonpositive/out-of-range fee ${String(fee)}`, async () =>
    refusal((value) => {
      (value.fees as Record<string, unknown>[])[0].feeLamports = fee;
    }));
it('compares each fee against its own original swap or tip cap', async () => {
  const { manifest } = await jitoBundleFixture(2);
  manifest.swaps[0].maximumFeeLamports = '4000';
  manifest.swaps[1].maximumFeeLamports = '6000';
  manifest.tip.feeLamports = '3000';
  const { sha256: _, ...terms } = manifest;
  manifest.sha256 = await bundleFingerprint(terms);
  const base = diagnostic(manifest);
  expect(requireResult(base, manifest)).toBe(base);
  for (let i = 0; i < base.fees.length; i++) {
    const value = structuredClone(base);
    value.fees[i].feeLamports = (
      BigInt(value.fees[i].feeLamports) + 1n
    ).toString();
    expect(() => requireResult(value, manifest)).toThrow();
  }
});
it('admits a positive canonical u64 fee only when the supplied original diagnostic cap permits it', async () => {
  const { manifest } = await jitoBundleFixture();
  manifest.swaps[0].maximumFeeLamports = '18446744073709551615';
  const { sha256: _, ...terms } = manifest;
  manifest.sha256 = await bundleFingerprint(terms);
  const value = diagnostic(manifest);
  expect(requireResult(value, manifest).fees[0].feeLamports).toBe(
    '18446744073709551615',
  );
  expect(value.signingAllowed).toBe(false);
});
it('rejects duplicate fee indexes, sparse arrays, excessive vectors and unknown fee shapes', async () => {
  await refusal((value) => {
    const fees = value.fees as Record<string, unknown>[];
    fees[1].packet = 0;
  });
  await refusal((value) => {
    value.fees = Object.assign([], { length: 2 });
  });
  await refusal((value) => {
    const fees = value.fees as unknown[];
    fees.push(fees[0]);
  });
  await refusal((value) => {
    value.fees = [null];
    value.status = 'refused';
    value.reason = 'fees-refused';
    value.simulationSlot = null;
  });
});

it('refuses impossible packet counts even when an invalid caller manifest has a matching count', async () => {
  const { manifest } = await jitoBundleFixture();
  for (const swaps of [
    [],
    Array.from({ length: 5 }, () => manifest.swaps[0]),
  ]) {
    const impossible = { ...manifest, swaps };
    expect(() => requireResult(diagnostic(impossible), impossible)).toThrow();
  }
});
