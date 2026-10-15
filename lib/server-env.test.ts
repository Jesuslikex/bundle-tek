import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { expect, it } from 'vitest';

const source = transformSync(
  readFileSync(new URL('./server-env.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;

function load(globals: Record<string, unknown>) {
  const sandboxModule = { exports: {} as { env: NodeJS.ProcessEnv } };
  runInNewContext(source, {
    module: sandboxModule,
    exports: sandboxModule.exports,
    ...globals,
  });
  return sandboxModule.exports.env;
}

it('imports without a Node process in the browser and refuses provider reads', () => {
  const env = load({ window: {} });
  expect(() => env.SOLANA_MAINNET_RPC_URL).toThrow(
    'Server provider configuration is unavailable in the browser.',
  );
});

it('does not use a browser process shim to expose provider configuration', () => {
  const env = load({ window: {}, process: { env: { EXAMPLE: 'fixture' } } });
  expect(() => env.EXAMPLE).toThrow('unavailable in the browser');
});

it('retains the original server environment and observes updates', () => {
  const server = { EXAMPLE: 'first' };
  const env = load({ process: { env: server } });
  expect(env).toBe(server);
  server.EXAMPLE = 'updated';
  expect(env.EXAMPLE).toBe('updated');
});
