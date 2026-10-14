import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { raw } from '../test/pump-launch-simulation-fixture';
import {
  pumpGroupProgramDataLink,
  requirePumpGroupDeploymentHeader,
  PUMP_UPGRADEABLE_LOADER,
} from './pump-launch-group-deployments';

it('decodes an exact upgradeable executable link', () => {
  const bytes = new Uint8Array(36);
  new DataView(bytes.buffer).setUint32(0, 2, true);
  bytes.fill(7, 4);
  expect(
    pumpGroupProgramDataLink(
      'program',
      raw(PUMP_UPGRADEABLE_LOADER, bytes, '1000000', true),
    ),
  ).toBe(bs58.encode(bytes.slice(4)));
  expect(() =>
    pumpGroupProgramDataLink(
      'program',
      raw(PUMP_UPGRADEABLE_LOADER, bytes.slice(1), '1000000', true),
    ),
  ).toThrow('link differs');
});
it('accepts native loader only for the known System executable', () => {
  const account = raw(
    'NativeLoader1111111111111111111111111111111',
    Uint8Array.of(1),
    '1000000',
    true,
  );
  expect(
    pumpGroupProgramDataLink('11111111111111111111111111111111', account),
  ).toBeNull();
  expect(() => pumpGroupProgramDataLink('other', account)).toThrow(
    'loader profile',
  );
});
it('rejects absent, non-executable and unsupported loader accounts', () => {
  expect(() => pumpGroupProgramDataLink('program', null)).toThrow();
  expect(() =>
    pumpGroupProgramDataLink(
      'program',
      raw(PUMP_UPGRADEABLE_LOADER, new Uint8Array(36)),
    ),
  ).toThrow();
  expect(() =>
    pumpGroupProgramDataLink(
      'program',
      raw(
        'LoaderV411111111111111111111111111111111111',
        new Uint8Array(36),
        '1000000',
        true,
      ),
    ),
  ).toThrow();
});
it('requires a complete ProgramData header no newer than replay bank', () => {
  const bytes = new Uint8Array(45),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, 100n, true);
  bytes[12] = 1;
  expect(() =>
    requirePumpGroupDeploymentHeader(raw(PUMP_UPGRADEABLE_LOADER, bytes), 100),
  ).not.toThrow();
  expect(() =>
    requirePumpGroupDeploymentHeader(raw(PUMP_UPGRADEABLE_LOADER, bytes), 99),
  ).toThrow('newer');
  bytes[12] = 2;
  expect(() =>
    requirePumpGroupDeploymentHeader(raw(PUMP_UPGRADEABLE_LOADER, bytes), 100),
  ).toThrow('malformed');
  expect(() =>
    requirePumpGroupDeploymentHeader(
      raw(PUMP_UPGRADEABLE_LOADER, bytes.slice(0, 12)),
      100,
    ),
  ).toThrow();
  expect(() =>
    requirePumpGroupDeploymentHeader(
      raw('11111111111111111111111111111111', bytes),
      100,
    ),
  ).toThrow('owner');
});
