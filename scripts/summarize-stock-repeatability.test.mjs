import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStockRepeatability } from './summarize-stock-repeatability.mjs';

test('binds new sample runtime evidence without relabelling historical receipts', () => {
  const rows = samples();
  assert.equal(summarizeStockRepeatability(rows).harnessRuntime, undefined);
  for (const r of rows)
    r.harnessRuntime = { nodeVersion: '24.19.0', requiredNodeMajor: 24 };
  assert.deepEqual(
    summarizeStockRepeatability(rows).harnessRuntime,
    rows[0].harnessRuntime,
  );
  const missing = structuredClone(rows);
  delete missing[2].harnessRuntime;
  assert.throws(() => summarizeStockRepeatability(missing), /runtime changed/);
  const changed = structuredClone(rows);
  changed[1].harnessRuntime.nodeVersion = '24.20.0';
  assert.throws(() => summarizeStockRepeatability(changed), /runtime changed/);
  for (const r of rows) r.harnessRuntime.nodeVersion = '26.4.0';
  assert.throws(() => summarizeStockRepeatability(rows), /production Node 24/);
});

test('rejects rotating or dropping a pinned fixture even for refused runs', () => {
  const rows = samples();
  for (const r of rows)
    Object.assign(r, {
      passed: false,
      publicReferenceKind: 'idle-public-transaction-reference',
      referenceFixtureSha256: 'c'.repeat(64),
      publicReferenceSha256: (r.quoteAsset === 'SOL' ? 'a' : 'b').repeat(64),
    });
  assert.equal(summarizeStockRepeatability(rows).repeatableInThisSample, false);
  const changed = structuredClone(rows);
  changed[2].publicReferenceSha256 = 'd'.repeat(64);
  assert.throws(() => summarizeStockRepeatability(changed), /identity changed/);
  const omitted = structuredClone(rows);
  delete omitted[4].referenceFixtureSha256;
  assert.throws(() => summarizeStockRepeatability(omitted), /fixture changed/);
  const missingIdentity = structuredClone(rows);
  missingIdentity[0].passed = true;
  delete missingIdentity[0].publicReferenceSha256;
  assert.throws(
    () => summarizeStockRepeatability(missingIdentity),
    /identity missing/,
  );
});

test('counts setup and runtime methods together and rejects omitted or under-reported setup admissions', () => {
  const rows = samples();
  for (const r of rows) {
    Object.assign(r, {
      rpcPacingScope: 'setup-and-runtime',
      maximumRollingRpcMethods: 3,
      requests: [
        { status: 200, startMs: 0, methods: ['getTransaction'], rpcUnits: 1 },
        {
          status: 200,
          startMs: 500,
          methods: ['getSlot', 'getBlockHeight'],
          rpcUnits: 2,
        },
      ],
    });
  }
  expectValid(rows);
  const underReported = structuredClone(rows);
  underReported[0].maximumRollingRpcMethods = 2;
  assert.throws(
    () => summarizeStockRepeatability(underReported),
    /setup\/runtime pacing/,
  );
  const missing = structuredClone(rows);
  delete missing[0].requests[0].rpcUnits;
  assert.throws(() => summarizeStockRepeatability(missing), /method count/);
});
function expectValid(rows) {
  assert.equal(summarizeStockRepeatability(rows).repeatableInThisSample, true);
}

test('requires unchanged quiet activity and includes its audit in the 32-slot qualification span', () => {
  const rows = samples();
  for (const r of rows)
    Object.assign(r, {
      publicReferenceKind: 'idle-public-transaction-reference',
      runtime: { ...r.runtime, minimumSlot: 1000, maximumSlot: 1030 },
      qualificationElapsedSlots: 31,
      quietReferenceObserved: true,
      referenceActivity: {
        before: {
          observedSlot: 990,
          latestActivitySlot: '700',
          latestSignatureSha256: 'a'.repeat(64),
          idleSlots: 290,
        },
        after: {
          observedSlot: 1031,
          latestActivitySlot: '700',
          latestSignatureSha256: 'a'.repeat(64),
          idleSlots: 331,
        },
        outcome: 'no-new-observed-activity',
      },
    });
  expectValid(rows);
  for (const mutate of [
    (r) => {
      r.referenceActivity.after.latestSignatureSha256 = 'b'.repeat(64);
    },
    (r) => {
      r.referenceActivity.after = null;
    },
    (r) => {
      r.referenceActivity.after.observedSlot = 1033;
      r.qualificationElapsedSlots = 33;
    },
    (r) => {
      r.quietReferenceObserved = false;
    },
  ]) {
    const changed = structuredClone(rows);
    mutate(changed[0]);
    assert.throws(
      () => summarizeStockRepeatability(changed),
      /Quiet reference/,
    );
  }
});

const samples = () =>
  Array.from({ length: 6 }, (_, i) => ({
    format: 'stock-pair-live-qualification-v1',
    checkedAt: new Date(Date.UTC(2026, 9, 16, 14, i)).toISOString(),
    quoteAsset: i % 2 ? 'USDC' : 'SOL',
    inputUiAmount: i % 2 ? '1' : '0.001',
    readOnly: true,
    sourceUnchanged: true,
    sourceFiles: { 'runtime.ts': 'unchanged' },
    signatures: 0,
    broadcasts: 0,
    privateKeys: 0,
    userWallets: 0,
    signingAllowed: false,
    executionAllowed: false,
    passed: true,
    stage: 'complete',
    maximumRollingRpcMethods: 9,
    simulationCount: 1,
    http429: 0,
    requests: [{ status: 200 }],
    logicalReads: [],
    pipelineMs: 8000,
    firstCodeReads: 14,
    finalCodeReads: 14,
    elapsedSlots: 30,
    runtime: {
      minimumSlot: 100,
      maximumSlot: 130,
      signingAllowed: false,
      executionAllowed: false,
    },
  }));

test('six complete bounded runs provide only sample repeatability, never signing permission', () => {
  const result = summarizeStockRepeatability(samples());
  assert.equal(result.repeatableInThisSample, true);
  assert.deepEqual(
    result.assets.map((x) => x.passed),
    [3, 3],
  );
  assert.equal(result.signingAllowed, false);
  assert.equal(result.executionAllowed, false);
});

test('keeps every refusal in the denominator instead of replacing it with a later pass', () => {
  const rows = samples();
  Object.assign(rows[1], {
    passed: false,
    runtime: undefined,
    elapsedSlots: null,
    stage: 'order-first-runtime',
    reason: 'fresh quote required',
    simulationCount: 0,
  });
  const result = summarizeStockRepeatability(rows);
  assert.equal(result.repeatableInThisSample, false);
  assert.equal(result.assets[1].attempted, 3);
  assert.equal(result.assets[1].passed, 2);
  assert.equal(result.attempts[1].reason, 'fresh quote required');
});

test('rejects missing, repeated, reordered or changed-source attempts', () => {
  assert.throws(() => summarizeStockRepeatability(samples().slice(1)));
  for (const change of [
    (rows) => {
      rows[2] = rows[0];
    },
    (rows) => {
      [rows[0], rows[1]] = [rows[1], rows[0]];
    },
    (rows) => {
      rows[2].sourceFiles = { 'runtime.ts': 'changed' };
    },
    (rows) => {
      rows[0].sourceUnchanged = false;
    },
  ]) {
    const rows = samples();
    change(rows);
    assert.throws(() => summarizeStockRepeatability(rows));
  }
});

test('refuses claimed passes beyond 32 slots or without the final scan and single simulation', () => {
  for (const change of [
    (row) => {
      row.runtime.maximumSlot = 133;
      row.elapsedSlots = 33;
    },
    (row) => {
      row.finalCodeReads = 0;
    },
    (row) => {
      delete row.finalCodeReads;
    },
    (row) => {
      row.simulationCount = 2;
    },
    (row) => {
      row.runtime.signingAllowed = true;
    },
    (row) => {
      row.elapsedSlots = 29;
    },
    (row) => {
      row.stage = 'order-first-runtime';
    },
  ]) {
    const rows = samples();
    change(rows[0]);
    assert.throws(() => summarizeStockRepeatability(rows));
  }
});

test('rejects wallet actions, excessive pacing and inconsistent 429 accounting', () => {
  for (const change of [
    (row) => {
      row.broadcasts = 1;
    },
    (row) => {
      row.signatures = 1;
    },
    (row) => {
      row.privateKeys = 1;
    },
    (row) => {
      row.maximumRollingRpcMethods = 10;
    },
    (row) => {
      row.http429 = 1;
    },
    (row) => {
      row.requests[0].status = 429;
      row.http429 = 1;
    },
    (row) => {
      row.requests[0].status = 500;
    },
  ]) {
    const rows = samples();
    change(rows[0]);
    assert.throws(() => summarizeStockRepeatability(rows));
  }
});

test('applies a configured stock runtime method budget per endpoint', () => {
  const ok = samples();
  for (const r of ok) {
    r.qualificationMethodBudget = 25;
    r.maximumRollingRpcMethodsByRole = {
      'indexer-fallback': 9,
      'stock-runtime': 20,
    };
    r.maximumRollingRpcMethods = 20;
  }
  summarizeStockRepeatability(ok);
  for (const change of [
    (row) => {
      row.maximumRollingRpcMethodsByRole['stock-runtime'] = 26;
      row.maximumRollingRpcMethods = 26;
    },
    (row) => {
      row.maximumRollingRpcMethodsByRole['indexer-fallback'] = 10;
    },
    (row) => {
      row.qualificationMethodBudget = 100;
    },
  ]) {
    const rows = structuredClone(ok);
    change(rows[0]);
    assert.throws(() => summarizeStockRepeatability(rows));
  }
});
