import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const sources = [
  'scripts/qualify-jito-cpmm-campaign.mjs',
  'scripts/qualify-jito-provider-observed.mjs',
  'scripts/qualify-jito-cpmm-provider-observed.ts',
  ...[
    'helius-readonly-pacing',
    'helius-refusal',
    'coherent-prefee-attempt',
    'fee-batch',
    'simulation-response',
    'simulation-json',
    'rpc-batch-capture',
    'bundle-simulation-frames',
    'runtime-evidence',
    'cpmm-source-identity',
    'cpmm-unsigned-packet',
    'cpmm-unsigned-review',
    'cpmm-state-replay',
    'cpmm-candidate-instruction',
    'cpmm-candidate-balances',
    'cpmm-asset-evidence',
    'cpmm-pool-evidence',
    'cpmm-price-evidence',
    'cpmm-constant-product',
    'cpmm-current-quote',
    'cpmm-ata-setup',
    'cpmm-setup-bundle-replay',
    'cpmm-bundle-replay',
    'cpmm-bank-anchor',
    'cpmm-code-compression',
    'cpmm-lifetime',
    'tip-account-evidence',
  ].map((s) => `lib/jito-${s}.ts`),
  ...[
    'pump-group-code-identity',
    'pump-launch-group-deployments',
    'pair-stock-clock',
    'pair-rent-evidence',
    'pair-runtime-exposure',
    'pair-trusted-programs',
    'swap-token-program-evidence',
    'wallet-rpc-pacing',
    'solana-transfer-message',
    'token-market',
    'server-env',
  ].map((s) => `lib/${s}.ts`),
];
const hash = (b) => createHash('sha256').update(b).digest('hex');
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(sources.map(async (p) => [p, hash(await readFile(p))])),
  );
async function child() {
  return new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      [
        'scripts/qualify-jito-provider-observed.mjs',
        '--live-readonly',
        '--raydium-cpmm',
        '--helius-qualification-pacing',
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const out = [],
      err = [];
    let bytes = 0,
      stderrBytes = 0,
      killed = false;
    const timer = setTimeout(() => {
      killed = true;
      p.kill();
    }, 55000);
    p.stdout.on('data', (b) => {
      bytes += b.length;
      if (bytes > 262144) {
        killed = true;
        p.kill();
      } else out.push(b);
    });
    p.stderr.on('data', (b) => {
      stderrBytes += b.length;
      if (stderrBytes <= 16384) err.push(b);
    });
    p.on('error', () => {
      killed = true;
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      let value = null;
      try {
        value = JSON.parse(stdout.toString('utf8'));
      } catch {}
      resolve({
        code,
        killed,
        value,
        stdoutSha256: hash(stdout),
        stderrSha256: hash(Buffer.concat(err)),
      });
    });
  });
}
async function main() {
  if (
    process.versions.node.split('.')[0] !== '24' ||
    process.argv.length !== 3 ||
    process.argv[2] !== '--live-readonly'
  )
    throw Error('campaign scope');
  const u = new URL(process.env.SOLANA_MAINNET_RPC_URL);
  if (
    u.protocol !== 'https:' ||
    u.hostname !== 'mainnet.helius-rpc.com' ||
    u.username ||
    u.password ||
    u.port ||
    u.hash
  )
    throw Error('endpoint scope');
  await mkdir('work', { recursive: true });
  const receipt = `work/jito-cpmm-campaign-${Date.now()}.json`,
    sourceHashes = await hashes();
  const state = {
    format: 'fixed-three-unsigned-cpmm-campaign-v2',
    fixedAttempts: 3,
    cooldownBeforeEachAttemptMs: 2000,
    sourceHashes,
    sourceUnchanged: true,
    results: [],
    stopReason: null,
    campaignPassed: false,
    signingAllowed: false,
    executionAllowed: false,
  };
  await writeFile(receipt, JSON.stringify(state, null, 2) + '\n');
  for (let i = 0; i < 3; i++) {
    // Cold-start/cross-process headroom OUTSIDE the new F..F+32 observation.
    // No retry, resubmission, discarded attempt or old packet reuse.
    await delay(2000);
    if (JSON.stringify(await hashes()) !== JSON.stringify(sourceHashes)) {
      state.sourceUnchanged = false;
      state.stopReason = 'source-changed';
      break;
    }
    const run = await child(),
      value = run.value,
      s = value?.summary;
    if (
      run.code !== 0 ||
      run.killed ||
      !s ||
      !/^work\/jito-cpmm-provider-observed-\d+\.json$/.test(value.receipt ?? '')
    ) {
      state.results.push({
        attempt: i + 1,
        status: 'startup-or-output-refused',
        code: run.code,
        killed: run.killed,
        stdoutSha256: run.stdoutSha256,
        stderrSha256: run.stderrSha256,
      });
      state.stopReason = 'child-refused';
      break;
    }
    state.results.push({ attempt: i + 1, ...value });
    state.sourceUnchanged =
      JSON.stringify(await hashes()) === JSON.stringify(sourceHashes);
    console.log(
      JSON.stringify({
        attempt: i + 1,
        status: s.status,
        slotSpan: s.slotSpan ?? null,
        stage: s.stage,
        rateLimited: s.rateLimited,
        refusal: s.refusal ?? null,
        receipt: value.receipt,
      }),
    );
    await writeFile(receipt, JSON.stringify(state, null, 2) + '\n');
    if (!state.sourceUnchanged) {
      state.stopReason = 'source-changed';
      break;
    }
    if (s.rateLimited === true) {
      state.stopReason = 'rate-limit';
      break;
    }
  }
  state.campaignPassed =
    state.sourceUnchanged &&
    state.results.length === 3 &&
    state.results.every(
      ({ summary: s }) =>
        s?.profile === 'provider-observed-raydium-cpmm-runtime-v1' &&
        s.status === 'unsigned-cpmm-checks-passed-provider-trust-required' &&
        s.completeSwapEvidenceChecked === true &&
        Number.isSafeInteger(s.slotSpan) &&
        s.slotSpan <= 32 &&
        s.maximumSlot - s.floor === s.slotSpan &&
        s.simulationSlot >= s.floor &&
        s.maximumSlot >= s.simulationSlot &&
        s.runtimeProof?.fullCodeScansMatched === true &&
        s.runtimeProof?.matchedSourceIdentityChecked === true &&
        s.runtimeProof?.conservativeRuntimeChecksPassed === true &&
        s.bankIdentityVerified === false &&
        s.feeBankIdentityVerified === false &&
        s.fullSwapQualified === false &&
        s.signingAllowed === false &&
        s.executionAllowed === false &&
        s.rateLimited === false,
    );
  await writeFile(receipt, JSON.stringify(state, null, 2) + '\n');
  console.log(
    JSON.stringify({
      receipt,
      campaignPassed: state.campaignPassed,
      completedAttempts: state.results.length,
      stopReason: state.stopReason,
    }),
  );
}
main().catch(() => {
  console.log(
    JSON.stringify({
      status: 'campaign-startup-refused',
      signingAllowed: false,
      executionAllowed: false,
    }),
  );
  process.exitCode = 1;
});
