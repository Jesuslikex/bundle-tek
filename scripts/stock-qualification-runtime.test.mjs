import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  requireStockQualificationRuntime,
  STOCK_QUALIFICATION_NODE_MAJOR,
} from './stock-qualification-runtime.mjs';

test('qualification major agrees with the production engine and records exact patch', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url)),
  );
  assert.equal(pkg.engines.node, `${STOCK_QUALIFICATION_NODE_MAJOR}.x`);
  assert.deepEqual(requireStockQualificationRuntime('24.19.0'), {
    nodeVersion: '24.19.0',
    requiredNodeMajor: 24,
  });
});

test('rejects other runtime majors and malformed version evidence', () => {
  for (const version of [
    '22.20.0',
    '26.4.0',
    '240.0.0',
    '24',
    '24.1',
    'v24.19.0',
    '24.19.0-rc',
    '',
    null,
    24,
  ])
    assert.throws(
      () => requireStockQualificationRuntime(version),
      /production Node 24/,
    );
});
