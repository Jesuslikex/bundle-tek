import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import {
  jitoBundleActivity,
  isJitoBundleActivity,
  jitoBundleActivityLabel,
} from './jito-bundle-activity';
it('distinguishes signature registration, uncertain submission and finalization', async () => {
  const { manifest } = await jitoBundleFixture();
  const signatures = [
    bs58.encode(new Uint8Array(64).fill(1)),
    bs58.encode(new Uint8Array(64).fill(2)),
  ];
  const record = {
    manifest,
    state: 'reviewed' as const,
    bundleId: null,
    signatures,
    updatedAt: manifest.createdAt,
  };
  const projected = jitoBundleActivity(record);
  expect(projected.signedCount).toBe(2);
  expect(jitoBundleActivityLabel(projected)).toContain('awaiting submission');
  expect(
    jitoBundleActivityLabel(
      jitoBundleActivity({ ...record, state: 'submitting' }),
    ),
  ).toContain('uncertain');
  expect(
    jitoBundleActivityLabel(
      jitoBundleActivity({ ...record, state: 'finalized' }),
    ),
  ).toBe('Jito bundle finalized');
  expect(() => jitoBundleActivity({ ...record, state: 'submitted' })).toThrow();
  expect(() =>
    jitoBundleActivity({
      ...record,
      state: 'finalized',
      signatures: [null, null],
    }),
  ).toThrow();
  expect(() =>
    jitoBundleActivity({
      ...record,
      signatures: [signatures[0], signatures[0]],
    }),
  ).toThrow();
  expect(() =>
    jitoBundleActivity({ ...record, signatures: ['malformed', null] }),
  ).toThrow();
  expect(isJitoBundleActivity({ ...projected, swapCount: 5 })).toBe(false);
  expect(isJitoBundleActivity({ ...projected, state: ['reviewed'] })).toBe(false);
  expect(isJitoBundleActivity({ ...projected, state: '__proto__' })).toBe(
    false,
  );
  expect(isJitoBundleActivity({ ...projected, tipLamports: '1' })).toBe(false);
});
