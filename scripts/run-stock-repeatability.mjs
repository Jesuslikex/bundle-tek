// Six independent unsigned attempts. A rate limit stops the entire campaign.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarizeStockRepeatability } from './summarize-stock-repeatability.mjs';

export async function runStockRepeatability(attempt) {
  const results = [];
  for (let round = 1; round <= 3; round++) {
    for (const asset of ['SOL', 'USDC']) {
      const result = await attempt({ round, asset });
      results.push(result);
      if (result.http429 > 0)
        return { complete: false, stoppedForRateLimit: true, results };
    }
  }
  return { complete: true, stoppedForRateLimit: false, results };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const referenceArg = process.argv[3];
  if (
    ![3, 4].includes(process.argv.length) ||
    process.argv[2] !== '--live-readonly' ||
    (referenceArg !== undefined &&
      !referenceArg.startsWith('--reference-file='))
  )
    throw Error(
      'Use --live-readonly. No signing, send, retry or deployment mode exists.',
    );
  const folder = resolve(
    'work/stock-repeatability-' +
      new Date().toISOString().replaceAll(/[:.]/g, '-'),
  );
  mkdirSync(folder, { recursive: true });
  const campaign = await runStockRepeatability(async ({ round, asset }) => {
    const args = [
      '--env-file=.env.local',
      'scripts/qualify-stock-pair-runtime.mjs',
      '--live-readonly',
      '--idle-reference',
      ...(referenceArg === undefined ? [] : [referenceArg]),
      ...(asset === 'USDC' ? ['--quote-usdc', '--one-unit'] : []),
    ];
    const result = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '',
        tooLarge = false;
      child.stdout.on('data', (data) => {
        text += data;
        if (text.length > 32768) {
          tooLarge = true;
          child.kill();
        }
      });
      // Never forward provider/tool stderr or accidentally print environment values.
      child.stderr.on('data', () => {});
      child.on('error', () =>
        reject(Error('Unsigned qualifier process unavailable.')),
      );
      child.on('close', (code) => {
        if (tooLarge || ![0, 1].includes(code))
          return reject(Error('Unsigned qualifier process failed.'));
        try {
          const row = JSON.parse(text.trim().split(/\r?\n/).at(-1));
          const receipt = JSON.parse(readFileSync(row.receipt, 'utf8'));
          if (
            receipt.quoteAsset !== asset ||
            receipt.readOnly !== true ||
            receipt.signatures !== 0 ||
            receipt.broadcasts !== 0 ||
            !Number.isInteger(receipt.http429) ||
            receipt.http429 < 0
          )
            throw Error();
          accept({
            round,
            asset,
            receipt: row.receipt,
            passed: receipt.passed,
            http429: receipt.http429,
          });
        } catch {
          reject(
            Error('Unsigned qualifier did not return a valid bounded receipt.'),
          );
        }
      });
    });
    console.log(JSON.stringify(result));
    return result;
  });
  const receipts = campaign.results.map((row) =>
    JSON.parse(readFileSync(row.receipt, 'utf8')),
  );
  const evidence = {
    referencePolicy: 'idle-before-and-after',
    format: 'stock-pair-bounded-campaign-v1',
    ...campaign,
    // An incomplete campaign is never padded into a successful six-run sample.
    summary: campaign.complete ? summarizeStockRepeatability(receipts) : null,
    retryNotBefore: campaign.stoppedForRateLimit
      ? new Date(Date.now() + 60000).toISOString()
      : null,
    receipts,
    signingAllowed: false,
    executionAllowed: false,
  };
  const output = join(folder, 'campaign.json');
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      output,
      complete: campaign.complete,
      stoppedForRateLimit: campaign.stoppedForRateLimit,
      repeatableInThisSample: evidence.summary?.repeatableInThisSample ?? false,
      assets: evidence.summary?.assets ?? null,
    }),
  );
}
