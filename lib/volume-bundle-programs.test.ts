import { expect, it } from 'vitest';
import { volumeProgramFixture } from '../test/volume-program-fixture';
import {
  validateVolumeProgramRuntime,
  requireVolumeProgramPolicy,
} from './volume-bundle-programs';
import { volumeDigest } from './volume-bundle-construction';
import type { VolumeSimulationRpc } from './volume-bundle-simulation';
it('denies an unset production policy before any RPC', async () => {
  const f = await volumeProgramFixture();
  let calls = 0;
  await expect(
    validateVolumeProgramRuntime(
      f.review,
      f.route,
      async () => {
        calls++;
        throw new Error('Not called');
      },
      new AbortController().signal,
      1000,
    ),
  ).rejects.toThrow(/separately reviewed/);
  expect(calls).toBe(0);
});
it.each(['programData', 'upgradeAuthority', 'deploymentSlot'])(
  'refuses malformed reviewed %s even with a recomputed policy hash',
  async (kind) => {
    const f = await volumeProgramFixture();
    f.policy.programs[0][
      kind as 'programData' | 'upgradeAuthority' | 'deploymentSlot'
    ] = kind === 'deploymentSlot' ? '0' : 'invalid';
    const { sha256: _old, ...terms } = f.policy;
    f.policy.sha256 = await volumeDigest(terms);
    await expect(requireVolumeProgramPolicy(f.policy)).rejects.toThrow();
  },
);
it('compares two full code scans around the actual unsigned simulation with a separate policy', async () => {
  const f = await volumeProgramFixture();
  const result = await validateVolumeProgramRuntime(
    f.review,
    f.route,
    f.rpc,
    new AbortController().signal,
    1000,
    f.policy,
    () => f.nowMs,
  );
  expect(result).toMatchObject({
    codePolicyVerified: true,
    semanticAuditEstablished: false,
    transportQualificationRequired: true,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(result.first.programs).toEqual(f.policy.programs);
  expect(result.second.programs).toEqual(result.first.programs);
  expect(result.simulation.constructionSha256).toBe(f.review.sha256);
});
it.each([
  'policy',
  'code',
  'authority',
  'link',
  'post-code',
  'simulation-header',
  'window',
])('refuses %s changes with no policy enrollment', async (kind) => {
  const f = await volumeProgramFixture();
  let simulated = false;
  if (kind === 'policy') f.policy.programs[0].codeSha256 = 'a'.repeat(64);
  const rpc: VolumeSimulationRpc = async (method, params, signal) => {
    if (method === 'simulateTransaction') simulated = true;
    const raw = await f.rpc(method, params, signal);
    if (
      method === 'getMultipleAccounts' &&
      (params[1] as { dataSlice?: unknown }).dataSlice
    ) {
      const keys = params[0] as string[],
        r = raw as {
          context: { slot: string };
          value: { data: [string, string] }[];
        };
      const config = params[1] as {
        dataSlice: { offset: number; length: number };
      };
      if (
        (kind === 'code' || (kind === 'post-code' && simulated)) &&
        config.dataSlice.offset === 45
      ) {
        const b = Uint8Array.from(atob(r.value[0].data[0]), (c) =>
          c.charCodeAt(0),
        );
        b[8] ^= 1;
        r.value[0].data[0] = btoa(String.fromCharCode(...b));
      }
      if (
        kind === 'authority' &&
        keys[0] === f.policy.programs[0].programData
      ) {
        const b = Uint8Array.from(atob(r.value[0].data[0]), (c) =>
          c.charCodeAt(0),
        );
        b[13] ^= 1;
        r.value[0].data[0] = btoa(String.fromCharCode(...b));
      }
      if (kind === 'link' && keys[0] === f.policy.programs[0].address) {
        const b = Uint8Array.from(atob(r.value[0].data[0]), (c) =>
          c.charCodeAt(0),
        );
        b[4] ^= 1;
        r.value[0].data[0] = btoa(String.fromCharCode(...b));
      }
      if (kind === 'window' && simulated) r.context.slot = '1033';
    }
    if (
      kind === 'simulation-header' &&
      method === 'getMultipleAccounts' &&
      !(params[1] as { dataSlice?: unknown }).dataSlice
    )
      (raw as { value: { owner: string }[] }).value[
        f.index(f.policy.programs[0].address)
      ].owner = f.input.mint;
    return raw;
  };
  await expect(
    validateVolumeProgramRuntime(
      f.review,
      f.route,
      rpc,
      new AbortController().signal,
      1000,
      f.policy,
      () => f.nowMs,
    ),
  ).rejects.toThrow();
});
