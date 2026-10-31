import { it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
it('retains an actual HTTP429 header refusal and stops after one mocked read without retry', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bundle-cpmm-429-')),
    preload = join(folder, 'preload.mjs');
  let receipt: string | null = null;
  try {
    await writeFile(
      preload,
      'globalThis.fetch = async () => new Response("rate limited", {status:429});',
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
    });
    expect(output.receipt).toMatch(
      /^work\/jito-cpmm-provider-observed-\d+\.json$/,
    );
    receipt = output.receipt;
    const retained = JSON.parse(await readFile(receipt!, 'utf8'));
    expect(retained.captures).toHaveLength(1);
    expect(retained.captures[0]).toMatchObject({
      httpStatus: 429,
      responseBodyRetained: false,
    });
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
}, 20000);
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
