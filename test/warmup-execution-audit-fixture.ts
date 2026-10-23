import bs58 from 'bs58';
import {
  executionManifest,
  executionId as id,
  executionHash as hash,
  executionNow,
} from './warmup-execution-ledger-fixture';
import {
  bindWarmupExecutionTerms,
  bindWarmupExecutionRoot,
  WARMUP_EXECUTION_ACKNOWLEDGEMENT,
} from '../lib/wallet-warmup-execution-terms';
import { WarmupExecutionLedger } from '../lib/wallet-warmup-execution-ledger';
import {
  warmupExecutionAuditGenesis,
  bindWarmupExecutionAuditEvent,
} from '../lib/wallet-warmup-execution-audit';
import { canonicalPumpHolderJson as canonical } from '../lib/pump-holder-review';
import { walletWarmupSessionDigest as digest } from '../lib/wallet-warmup-session-digest';

/** Synthetic historical model inputs only; opaque hashes are not real evidence. */
export async function executionAuditFixture(manifest = executionManifest()) {
  const { format: _format, consentSha256: _consent, ...intent } = manifest;
  const terms = {
    format: 'wallet-warmup-execution-terms-v1',
    intent: { ...intent, format: 'wallet-warmup-execution-intent-v1' },
    review: {
      id: id(50),
      sha256: hash(50),
      reviewedAt: intent.createdAt,
      reviewExpiresAt: new Date(
        Date.parse(intent.createdAt) + 60000,
      ).toISOString(),
    },
    verifierEvidenceSha256: hash(51),
  };
  const approval = {
    format: 'wallet-warmup-execution-approval-v1',
    id: intent.consentId,
    rootId: intent.id,
    ownerId: intent.ownerId,
    reviewId: terms.review.id,
    termsSha256: (await bindWarmupExecutionTerms(terms)).termsSha256,
    approvedAt: new Date(Date.parse(intent.createdAt) + 1000).toISOString(),
    sessionExpiresAt: intent.expiresAt,
    acknowledgement: WARMUP_EXECUTION_ACKNOWLEDGEMENT,
  };
  const bound = await bindWarmupExecutionRoot(terms, approval);
  const selector = {
    id: intent.id,
    ownerId: intent.ownerId,
    consentId: intent.consentId,
    reviewId: terms.review.id,
    rootSha256: bound.rootSha256,
  };
  const createdAt = new Date(Date.parse(intent.createdAt) + 2000).toISOString();
  const initial = await warmupExecutionAuditGenesis(
    bound.root,
    approval,
    selector,
    createdAt,
    new AbortController().signal,
  );
  const ledger = await WarmupExecutionLedger.create(bound.manifest),
    wires: string[] = [];
  let previous = initial.head.eventSha256,
    time = Date.parse(createdAt);
  async function step(operation: string, fields: Record<string, unknown> = {}) {
    const event = {
      operation,
      expectedRootSha256: bound.manifestSha256,
      expectedVersion: ledger.snapshot().version,
      now: time,
      ...fields,
    };
    ledger.apply(event);
    const entry = await bindWarmupExecutionAuditEvent({
      format: 'wallet-warmup-execution-event-v1',
      rootId: intent.id,
      rootSha256: bound.rootSha256,
      manifestSha256: bound.manifestSha256,
      sequence: wires.length + 1,
      previousSha256: previous,
      event,
    });
    previous = entry.sha256;
    wires.push(entry.wire);
    return entry;
  }
  const signature = (n: number) =>
    bs58.encode(
      Uint8Array.from({ length: 64 }, (_, i) =>
        i < 4 ? (n >>> (i * 8)) & 255 : 7,
      ),
    );
  async function ready(n = 1) {
    await step('reserve');
    await step('qualify', { evidenceSha256: hash(60000 + n) });
    await step('prepare', {
      qualificationEvidenceSha256: hash(60000 + n),
      packetSha256: hash(10000 + n),
      minimumOutputRaw: '1',
    });
    await step('authorize', {
      id: id(30000 + n),
      packetSha256: hash(10000 + n),
      recheckSha256: hash(90000 + n),
    });
    await step('dispatch-intent', {
      id: id(40000 + n),
      authorizationId: id(30000 + n),
      packetSha256: hash(10000 + n),
      signedPacketSha256: hash(20000 + n),
      signature: signature(n),
    });
  }
  async function settle(n = 1, fields: Record<string, unknown> = {}) {
    const inputRaw = ledger.snapshot().pending!.inputRaw;
    return step('settle', {
      packetSha256: hash(10000 + n),
      signedPacketSha256: hash(20000 + n),
      receiptId: id(50000 + n),
      sourceSha256: hash(70000 + n),
      signature: signature(n),
      inputRaw,
      outputRaw: '9',
      networkFeeLamports: '3',
      rentDebitLamports: '2',
      rentRefundLamports: '50',
      landedFailure: false,
      ...fields,
    });
  }
  async function head() {
    return {
      ...initial.head,
      version: wires.length,
      eventSha256: previous,
      checkpointSha256: await digest(
        canonical({
          ...initial.checkpoint,
          modelTime: time,
          snapshot: ledger.snapshot(time),
        }),
      ),
    };
  }
  return {
    bound,
    approval,
    selector,
    initial,
    ledger,
    wires,
    step,
    ready,
    settle,
    head,
    time(value: number) {
      time = value;
    },
    defaultTime: executionNow + 2000,
  };
}
