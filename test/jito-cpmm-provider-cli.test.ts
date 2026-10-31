import { it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
it.each([
  {
    name: 'plain HTTP429',
    status: 429,
    body: 'rate limited',
    retained: false,
    category: 'rate-limit',
  },
  {
    name: 'JSON-RPC -32005',
    status: 200,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'runtime:1',
      error: { code: -32005, message: 'Too many requests' },
    }),
    retained: true,
    category: 'rate-limit',
  },
  {
    name: 'HTTP429 quota',
    status: 429,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'runtime:1',
      error: { code: 429, message: 'Monthly credits exhausted' },
    }),
    retained: true,
    category: 'credit-quota',
  },
])(
  'retains $name and stops after one mocked read without retry',
  async (scenario) => {
    const folder = await mkdtemp(join(tmpdir(), 'bundle-cpmm-429-')),
      preload = join(folder, 'preload.mjs');
    let receipt: string | null = null;
    try {
      await writeFile(
        preload,
        `globalThis.fetch = async () => new Response(${JSON.stringify(scenario.body)}, {status:${scenario.status},headers:{'retry-after':'2'}});`,
      );
      const stdout = execFileSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          'scripts/qualify-jito-provider-observed.mjs',
          '--live-readonly',
          '--raydium-cpmm',
          '--helius-qualification-pacing',
        ],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: {
            ...process.env,
            SOLANA_MAINNET_RPC_URL:
              'https://mainnet.helius-rpc.com/?api-key=synthetic-test-only',
          },
        },
      );
      const output = JSON.parse(stdout);
      expect(output.summary).toMatchObject({
        status: 'refused',
        requests: 1,
        methods: 1,
        rateLimited: true,
        signingAllowed: false,
        executionAllowed: false,
        rateLimitEvidence: { rateLimited: true, category: scenario.category },
      });
      expect(output.receipt).toMatch(
        /^work\/jito-cpmm-provider-observed-\d+\.json$/,
      );
      receipt = output.receipt;
      const retained = JSON.parse(await readFile(receipt!, 'utf8'));
      expect(retained.captures).toHaveLength(1);
      expect(retained.captures[0]).toMatchObject({
        httpStatus: scenario.status,
      });
      if (scenario.status === 429)
        expect(retained.captures[0].responseBodyRetained).toBe(
          scenario.retained,
        );
      if (scenario.retained)
        expect(typeof retained.captures[0].responseSha256).toBe('string');
      expect(retained.captures[0].request).not.toContain('synthetic-test-only');
      expect(retained.captures[0].sentAtMs).toBeLessThanOrEqual(
        retained.captures[0].capturedAtMs,
      );
    } finally {
      if (
        receipt &&
        /^work\/jito-cpmm-provider-observed-\d+\.json$/.test(receipt)
      ) {
        await unlink(receipt);
        await unlink(
          receipt
            .replace('jito-cpmm-provider-observed-', 'jito-provider-observed-')
            .replace(/\.json$/, '.mjs'),
        );
      }
      await unlink(preload);
      await rmdir(folder);
    }
  },
  20000,
);
it('refuses an unrecognized pacing flag before loading providers', () => {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/qualify-jito-provider-observed.mjs',
      '--live-readonly',
      '--raydium-cpmm',
      '--unknown-pacing',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, SOLANA_MAINNET_RPC_URL: 'invalid' },
    },
  );
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: 'startup-refused',
    signingAllowed: false,
    executionAllowed: false,
  });
});
