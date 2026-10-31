import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
it('records the first documented RPC rate refusal and skips attempts two and three', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bundle-cpmm-campaign-')),
    preload = join(folder, 'mock.mjs');
  let campaign: string | null = null,
    child: string | null = null;
  try {
    await writeFile(
      preload,
      `globalThis.fetch=async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:'runtime:1',error:{code:-32005,message:'Too many requests'}}),{status:200});`,
    );
    const stdout = execFileSync(
      process.execPath,
      ['scripts/qualify-jito-cpmm-campaign.mjs', '--live-readonly'],
      {
        encoding: 'utf8',
        timeout: 20000,
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          SOLANA_MAINNET_RPC_URL:
            'https://mainnet.helius-rpc.com/?api-key=synthetic-only',
        },
      },
    );
    const lines = stdout
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s)),
      end = lines.at(-1);
    expect(end).toMatchObject({
      campaignPassed: false,
      completedAttempts: 1,
      stopReason: 'rate-limit',
    });
    expect(end.receipt).toMatch(/^work\/jito-cpmm-campaign-\d+\.json$/);
    campaign = end.receipt;
    const r = JSON.parse(await readFile(campaign!, 'utf8'));
    expect(r.results).toHaveLength(1);
    expect(r.sourceUnchanged).toBe(true);
    expect(r.signingAllowed).toBe(false);
    expect(r.results[0].summary).toMatchObject({
      rateLimited: true,
      requests: 1,
      methods: 1,
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(r.results[0].receipt).toMatch(
      /^work\/jito-cpmm-provider-observed-\d+\.json$/,
    );
    child = r.results[0].receipt;
  } finally {
    if (child && /^work\/jito-cpmm-provider-observed-\d+\.json$/.test(child)) {
      await unlink(child);
      await unlink(
        child
          .replace('jito-cpmm-provider-observed-', 'jito-provider-observed-')
          .replace(/\.json$/, '.mjs'),
      );
    }
    if (campaign && /^work\/jito-cpmm-campaign-\d+\.json$/.test(campaign))
      await unlink(campaign);
    await unlink(preload);
    await rmdir(folder);
  }
}, 25000);
