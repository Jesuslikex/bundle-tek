import { expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import * as facade from './jito-owned-registered-source';
import * as implementation from './jito-owned-registered-source-internal';

it('re-exports the same opaque-handle functions and no raw evidence accessor', () => {
  expect(Object.keys(facade).sort()).toEqual([
    'captureOwnedRegisteredJitoSource',
    'recheckOwnedRegisteredJitoSource',
  ]);
  expect(Object.keys(implementation).sort()).toEqual(Object.keys(facade).sort());
  expect(facade.captureOwnedRegisteredJitoSource).toBe(
    implementation.captureOwnedRegisteredJitoSource,
  );
  expect(facade.recheckOwnedRegisteredJitoSource).toBe(
    implementation.recheckOwnedRegisteredJitoSource,
  );
});
