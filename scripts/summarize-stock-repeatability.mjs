// Offline evidence only. This module never connects to a provider or enables signing.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { unchangedQuietReference } from './stock-reference-activity.mjs';
import { requireStockQualificationRuntime } from './stock-qualification-runtime.mjs';

export function summarizeStockRepeatability(receipts) {
  if (!Array.isArray(receipts) || receipts.length !== 6)
    throw Error('Exactly three alternating SOL/USDC rounds are required.');
  const seen = new Set();
  const source = JSON.stringify(receipts[0].sourceFiles);
  const harnessRuntime = receipts[0].harnessRuntime;
  const fixture = receipts[0].referenceFixtureSha256 ?? null;
  const referenceByAsset = new Map();
  const attempts = receipts.map((r, i) => {
    if (JSON.stringify(r.harnessRuntime) !== JSON.stringify(harnessRuntime))
      throw Error(
        'Qualification runtime changed or was omitted within the sample.',
      );
    if (harnessRuntime !== undefined) {
      const expected = requireStockQualificationRuntime(
        harnessRuntime?.nodeVersion,
      );
      if (JSON.stringify(expected) !== JSON.stringify(harnessRuntime))
        throw Error('Qualification runtime evidence differs.');
    }
    const asset = i % 2 === 0 ? 'SOL' : 'USDC';
    if (
      (r.referenceFixtureSha256 ?? null) !== fixture ||
      (fixture !== null &&
        (!/^[a-f0-9]{64}$/.test(fixture) ||
          r.publicReferenceKind !== 'idle-public-transaction-reference'))
    )
      throw Error(
        'Pinned fixture changed or omitted its quiet-reference policy.',
      );
    if (fixture !== null && r.passed && !r.publicReferenceSha256)
      throw Error('Pinned reference identity missing from a claimed pass.');
    if (fixture !== null && r.publicReferenceSha256) {
      if (
        !/^[a-f0-9]{64}$/.test(r.publicReferenceSha256) ||
        (referenceByAsset.has(asset) &&
          referenceByAsset.get(asset) !== r.publicReferenceSha256)
      )
        throw Error('Pinned reference identity changed within the sample.');
      referenceByAsset.set(asset, r.publicReferenceSha256);
    }
    if (
      r.format !== 'stock-pair-live-qualification-v1' ||
      r.quoteAsset !== asset ||
      r.inputUiAmount !== (asset === 'SOL' ? '0.001' : '1') ||
      !Number.isFinite(Date.parse(r.checkedAt)) ||
      seen.has(r.checkedAt) ||
      (i > 0 &&
        Date.parse(r.checkedAt) <= Date.parse(receipts[i - 1].checkedAt)) ||
      r.readOnly !== true ||
      r.sourceUnchanged !== true ||
      !r.sourceFiles ||
      Object.keys(r.sourceFiles).length === 0 ||
      JSON.stringify(r.sourceFiles) !== source ||
      r.signatures !== 0 ||
      r.broadcasts !== 0 ||
      r.privateKeys !== 0 ||
      r.userWallets !== 0 ||
      r.signingAllowed !== false ||
      r.executionAllowed !== false ||
      typeof r.passed !== 'boolean' ||
      !Number.isInteger(r.maximumRollingRpcMethods) ||
      r.maximumRollingRpcMethods < 0 ||
      !Number.isInteger(r.qualificationMethodBudget ?? 9) ||
      (r.qualificationMethodBudget ?? 9) < 1 ||
      (r.qualificationMethodBudget ?? 9) > 99 ||
      r.maximumRollingRpcMethods >
        Math.max(9, r.qualificationMethodBudget ?? 9) ||
      (r.maximumRollingRpcMethodsByRole?.['indexer-fallback'] ?? 0) > 9 ||
      (r.maximumRollingRpcMethodsByRole?.['stock-runtime'] ?? 0) >
        (r.qualificationMethodBudget ?? 9) ||
      !Number.isInteger(r.simulationCount) ||
      r.simulationCount < 0 ||
      r.simulationCount > 1 ||
      !Array.isArray(r.requests) ||
      !Array.isArray(r.logicalReads) ||
      !Number.isInteger(r.http429) ||
      (r.rpcRateLimited !== undefined &&
        typeof r.rpcRateLimited !== 'boolean') ||
      (r.rpcRateLimited === true && r.rateLimited === false) ||
      r.http429 !== r.requests.filter((x) => x.status === 429).length
    )
      throw Error(
        `Attempt ${i + 1} has inconsistent identity, source or safety evidence.`,
      );
    seen.add(r.checkedAt);
    if (r.rpcPacingScope === 'setup-and-runtime') {
      const methods = new Set([
        'getGenesisHash',
        'getLatestBlockhash',
        'getSlot',
        'getMultipleAccounts',
        'getBlockHeight',
        'getFeeForMessage',
        'isBlockhashValid',
        'simulateTransaction',
        'getSignaturesForAddress',
        'getLargestAccounts',
        'getTransaction',
      ]);
      const rpcByProvider = new Map();
      for (const row of r.requests) {
        if (
          !Array.isArray(row.methods) ||
          row.methods.length < 1 ||
          row.methods.length > 2 ||
          !Number.isFinite(row.startMs) ||
          row.startMs < 0
        )
          throw Error('Invalid actual request admission.');
        if (row.methods.every((m) => methods.has(m))) {
          if (row.rpcUnits !== row.methods.length)
            throw Error('RPC method count omitted or changed.');
          const provider = row.providerRole ?? 'default';
          if (
            !['default', 'indexer-fallback', 'stock-runtime'].includes(provider)
          )
            throw Error('Unknown RPC provider role.');
          const providerRows = rpcByProvider.get(provider) ?? [];
          providerRows.push(row);
          rpcByProvider.set(provider, providerRows);
        } else if (
          row.rpcUnits !== undefined ||
          row.methods.length !== 1 ||
          !['quote', 'unsigned-order'].includes(row.methods[0])
        )
          throw Error('Unknown read scope.');
      }
      const rolling = (rows) =>
        Math.max(
          0,
          ...rows.map((row) =>
            rows
              .filter(
                (other) =>
                  other.startMs <= row.startMs &&
                  other.startMs > row.startMs - 1000,
              )
              .reduce((total, other) => total + other.rpcUnits, 0),
          ),
        );
      const maximumByProvider = Object.fromEntries(
        [...rpcByProvider.entries()].map(([provider, rows]) => [
          provider,
          rolling(rows),
        ]),
      );
      const maximum = Math.max(0, ...Object.values(maximumByProvider));
      if (
        rpcByProvider.has('indexer-fallback') ||
        rpcByProvider.has('stock-runtime')
      ) {
        const reported = r.maximumRollingRpcMethodsByRole;
        if (
          !reported ||
          Object.keys(reported).some(
            (role) => !['indexer-fallback', 'stock-runtime'].includes(role),
          ) ||
          ['indexer-fallback', 'stock-runtime'].some(
            (role) => (reported[role] ?? 0) !== (maximumByProvider[role] ?? 0),
          )
        )
          throw Error('Per-provider pacing does not match its receipt.');
      }
      if (maximum !== r.maximumRollingRpcMethods)
        throw Error('Actual setup/runtime pacing does not match its receipt.');
    }
    const span = r.runtime
      ? r.runtime.maximumSlot - r.runtime.minimumSlot
      : null;
    if (
      r.passed &&
      (r.stage !== 'complete' ||
        !Number.isSafeInteger(span) ||
        span < 0 ||
        span > 32 ||
        r.elapsedSlots !== span ||
        r.simulationCount !== 1 ||
        !Number.isInteger(r.firstCodeReads) ||
        r.firstCodeReads <= 0 ||
        !Number.isInteger(r.finalCodeReads) ||
        r.finalCodeReads <= 0 ||
        r.runtime.signingAllowed !== false ||
        r.runtime.executionAllowed !== false ||
        r.http429 !== 0 ||
        r.rpcRateLimited === true ||
        r.requests.some((x) => x.status !== 200))
    )
      throw Error(
        `Attempt ${i + 1} claims completion without the full bounded runtime.`,
      );
    if (
      r.passed &&
      r.publicReferenceKind === 'idle-public-transaction-reference'
    ) {
      const activity = r.referenceActivity;
      // The bound is on the pipeline; the audit lands later and is checked
      // separately, matching the qualifier.
      const span = r.runtime
        ? r.runtime.maximumSlot - r.runtime.minimumSlot
        : null;
      const auditSpan =
        activity?.after && r.runtime
          ? activity.after.observedSlot - r.runtime.minimumSlot
          : null;
      if (
        !activity?.before ||
        !activity.after ||
        !unchangedQuietReference(activity.before, activity.after) ||
        r.quietReferenceObserved !== true ||
        activity.outcome !== 'no-new-observed-activity' ||
        !Number.isSafeInteger(span) ||
        span > 32 ||
        !Number.isSafeInteger(auditSpan) ||
        auditSpan < span ||
        r.qualificationElapsedSlots !== span
      )
        throw Error(
          'Quiet reference or full qualification span is not verified.',
        );
    }
    const phases = ['before-simulation', 'after-simulation'].map((phase) => {
      const reads = r.logicalReads.filter((x) => x.phase === phase);
      const slots = reads
        .map((x) => Number(x.slot))
        .filter(
          (x, index) =>
            reads[index].slot !== null &&
            reads[index].slot !== undefined &&
            Number.isSafeInteger(x),
        );
      return {
        phase,
        logicalReads: reads.length,
        codeReads: reads.filter((x) => x.profile === 'code').length,
        observedMinimumSlot: slots.length ? Math.min(...slots) : null,
        observedMaximumSlot: slots.length ? Math.max(...slots) : null,
      };
    });
    // A strict quote-bound refusal is the market moving, not a runtime failure.
    const marketRefusal =
      !r.passed && r.diagnosis?.classification === 'economic-minimum-output';
    return {
      round: Math.floor(i / 2) + 1,
      asset,
      checkedAt: r.checkedAt,
      passed: r.passed,
      refusalKind: r.passed
        ? null
        : marketRefusal
          ? 'market-quote-drift'
          : 'runtime',
      stage: r.stage,
      reason: r.reason ?? null,
      elapsedSlots: span,
      pipelineMs: r.pipelineMs,
      simulationCount: r.simulationCount,
      firstCodeReads: r.firstCodeReads,
      finalCodeReads: r.finalCodeReads,
      http429: r.http429,
      ...(r.rpcRateLimited === undefined
        ? {}
        : { rpcRateLimited: r.rpcRateLimited }),
      maximumRollingRpcMethods: r.maximumRollingRpcMethods,
      phases,
    };
  });
  return {
    format: 'stock-pair-repeatability-v1',
    sample: 'three fixed alternating rounds; no replacement attempts',
    sourceFiles: receipts[0].sourceFiles,
    ...(harnessRuntime === undefined ? {} : { harnessRuntime }),
    maximumSlots: 32,
    repeatableInThisSample: attempts.every((x) => x.passed),
    runtimeRepeatableExcludingMarketRefusals:
      attempts.every((x) => x.refusalKind !== 'runtime') &&
      ['SOL', 'USDC'].every((asset) =>
        attempts.some((x) => x.asset === asset && x.passed),
      ),
    assets: ['SOL', 'USDC'].map((asset) => ({
      asset,
      attempted: 3,
      passed: attempts.filter((x) => x.asset === asset && x.passed).length,
      marketRefusals: attempts.filter(
        (x) => x.asset === asset && x.refusalKind === 'market-quote-drift',
      ).length,
    })),
    signingAllowed: false,
    executionAllowed: false,
    deployed: false,
    attempts,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [output, ...files] = process.argv.slice(2);
  if (!output || files.length !== 6)
    throw Error('Usage: output.json SOL1 USDC1 SOL2 USDC2 SOL3 USDC3');
  const inputs = files.map((file) => readFileSync(file, 'utf8'));
  const receipts = inputs.map((input) => JSON.parse(input));
  const result = summarizeStockRepeatability(receipts);
  writeFileSync(
    output,
    JSON.stringify(
      {
        ...result,
        receiptSha256: inputs.map((input) =>
          createHash('sha256').update(input).digest('hex'),
        ),
        receipts,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      output,
      repeatableInThisSample: result.repeatableInThisSample,
      runtimeRepeatableExcludingMarketRefusals:
        result.runtimeRepeatableExcludingMarketRefusals,
      assets: result.assets,
    }),
  );
}
