import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('qualification source manifest binds every changed rate-limit path', () => {
  const source = readFileSync(
    new URL('./qualify-stock-pair-runtime.mjs', import.meta.url),
    'utf8',
  );
  const list = source.match(/const files = \[([\s\S]*?)\];/)?.[1];
  assert.ok(list, 'qualification source manifest is missing');
  const names = Array.from(list.matchAll(/'([^']+)'/g), (match) => match[1]);
  for (const path of [
    'lib/wallet-balances.ts',
    'lib/pair-read-rpc.ts',
    'scripts/stock-rpc-rate-limit.mjs',
    'scripts/qualify-stock-pair-runtime.mjs',
    'scripts/run-stock-repeatability.mjs',
    'scripts/summarize-stock-repeatability.mjs',
  ]) {
    assert.equal(names.filter((name) => name === path).length, 1, path);
  }
  assert.match(source, /files\.every\([\s\S]*?hash\(readFileSync\(p\)\)/);
});
