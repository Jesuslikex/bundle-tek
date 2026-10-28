import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import {
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
} from '@solana/kit';

export const REFERENCES = Object.freeze([
  '2k5hrzuykwyTbUe8L7UriYAQhr5hijNLgBvEB4B9pP5y',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
]);
export const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SYSTEM = '11111111111111111111111111111111';
const authority = Object.freeze({
  signingAllowed: false,
  executionAllowed: false,
  automaticExecutionAllowed: false,
  providerQualified: false,
  economicOutputVerified: false,
  runtimePrivilegesVerified: false,
});
const hash = (value) => createHash('sha256').update(value).digest('hex');
const encoded = (value) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const safeFailures = new WeakMap();
const failure = (reason) => {
  const error = new Error(reason);
  safeFailures.set(error, reason);
  return error;
};
const cancel = (response) => {
  if (response?.body && !response.body.locked)
    void response.body.cancel().catch(() => {});
};
const slot = (value) => {
  if (
    typeof value !== 'bigint' ||
    value < 0n ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw failure('invalid-slot');
  return Number(value);
};

export function validateEndpoint(value, providerMode = 'default') {
  if (!['default', 'helius'].includes(providerMode))
    throw failure('configuration-refused: invalid provider selection');
  if (!value)
    throw failure(
      providerMode === 'helius'
        ? 'configuration-refused: set SOLANA_MAINNET_RPC_URL for the Helius sample'
        : 'configuration-refused: set SOLANA_HOLDER_RPC_URL or SOLANA_MAINNET_RPC_URL',
    );
  try {
    const url = new URL(value);
    // Alchemy is the measured profile; the public endpoint is accepted so the
    // campaign can run at all, and the receipt records which host was used.
    if (
      url.protocol !== 'https:' ||
      !(
        providerMode === 'helius'
          ? ['mainnet.helius-rpc.com']
          : ['solana-mainnet.g.alchemy.com', 'api.mainnet-beta.solana.com']
      ).includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      throw failure(
        'configuration-refused: endpoint must be https Alchemy or public mainnet',
      );
    return url.href;
  } catch {
    throw failure('configuration-refused: endpoint is not a valid URL');
  }
}

/** Explicit sample selection; never switch providers after a refusal. */
export function selectNativeEndpoint(local, providerMode = 'default') {
  const value =
    providerMode === 'helius'
      ? local.SOLANA_MAINNET_RPC_URL
      : (local.SOLANA_HOLDER_RPC_URL ?? local.SOLANA_MAINNET_RPC_URL);
  return validateEndpoint(value, providerMode);
}

function packetsFor(payer, blockhash) {
  return REFERENCES.filter((key) => key !== payer)
    .slice(0, 2)
    .map((recipient) => {
      const data = new Uint8Array(12);
      new DataView(data.buffer).setUint32(0, 2, true);
      const messageBytes = getCompiledTransactionMessageEncoder().encode({
        version: 'legacy',
        header: {
          numSignerAccounts: 1,
          numReadonlySignerAccounts: 0,
          numReadonlyNonSignerAccounts: 1,
        },
        staticAccounts: [payer, recipient, SYSTEM],
        lifetimeToken: blockhash,
        instructions: [
          { programAddressIndex: 2, accountIndices: [0, 1], data },
        ],
      });
      return Object.freeze({
        transaction: Buffer.from(
          getTransactionEncoder().encode({
            messageBytes,
            signatures: { [payer]: null },
          }),
        ).toString('base64'),
        loadedAddresses: null,
        maximumFeeLamports: '5000',
        expectedFeeLamports: '5000',
      });
    });
}

/** No environment or network is accessed except through the explicitly injected dependencies. */
export async function runNativeJitoCampaign({
  endpoint,
  adapter,
  fetcher,
  persist,
  pace = adapter?.paceWalletRpc,
  signal,
  attemptTimeoutMs = 45000,
  profile = 'legacy',
  providerMode = 'default',
}) {
  const pinnedEndpoint = validateEndpoint(endpoint, providerMode);
  if (typeof pace !== 'function')
    throw failure('configuration-refused: adapter has no pacing function');
  if (
    !['legacy', 'prefee'].includes(profile) ||
    (profile === 'prefee' &&
      typeof adapter?.collectJitoCoherentPrefeeAttempt !== 'function')
  )
    throw failure('configuration-refused: invalid native profile');
  if (attemptTimeoutMs !== 45000)
    throw failure('configuration-refused: attempt timeout must be 45000 ms');
  const report = {
    profile:
      profile === 'prefee'
        ? 'unsigned-native-prefee-zero-transfer-only'
        : 'unsigned-native-zero-transfer-only',
    endpointHost: new URL(pinnedEndpoint).hostname,
    providerMode,
    plannedAttempts: 3,
    attempts: [],
    signaturesCreated: 0,
    broadcasts: 0,
    amountLamports: '0',
    ...authority,
  };
  let pinnedPayer;
  const saveReport = () => persist('campaign.json', encoded(report));
  saveReport();
  for (let index = 0; index < 3; index++) {
    const owner = new AbortController();
    const deadline = AbortSignal.any([
      owner.signal,
      AbortSignal.timeout(45000),
      ...(signal ? [signal] : []),
    ]);
    const responses = new Set();
    // Diagnostic wall-clock observations only. They are never used for bank,
    // budget, retry, signature, or execution admission.
    const timingOrigin = performance.now(),
      timingForRead = new WeakMap();
    let timingClosed = false;
    const elapsed = () => Math.max(0, performance.now() - timingOrigin);
    const mark = (timing, field) => {
      if (!timingClosed) timing[field] = elapsed();
    };
    const attempt = {
      index: index + 1,
      status: 'refused',
      reason: 'setup-failed',
      reads: [],
      diagnosticTimings: [],
      nativeCaptured: false,
      ...authority,
    };
    report.attempts.push(attempt);
    let logical = 0,
      phase = 'setup',
      rateLimited = false,
      budgetFailed = false;
    const prefix = `attempt-${index + 1}`;
    const keep = (name, bytes) => persist(`${prefix}/${name}`, bytes);
    const inWindow = (value) => {
      if (
        !Number.isSafeInteger(value) ||
        value < attempt.originalFloor ||
        value - attempt.originalFloor > 32
      )
        throw failure('original-window-refused');
    };
    async function bounded(pending) {
      deadline.throwIfAborted();
      let listener;
      try {
        return await Promise.race([
          pending,
          new Promise((_, reject) => {
            listener = () => reject(failure('interrupted'));
            deadline.addEventListener('abort', listener, { once: true });
            if (deadline.aborted) listener();
          }),
        ]);
      } finally {
        if (listener) deadline.removeEventListener('abort', listener);
      }
    }
    async function send(body, label) {
      deadline.throwIfAborted();
      const rows = JSON.parse(body);
      const requests = Array.isArray(rows) ? rows : [rows];
      const allowed = [
        'getGenesisHash',
        'getLatestBlockhash',
        'getMultipleAccounts',
        'getFeeForMessage',
        'simulateBundle',
      ];
      if (
        !requests.length ||
        requests.length > 3 ||
        requests.some((r) => r.jsonrpc !== '2.0' || !allowed.includes(r.method))
      )
        throw failure('request-refused');
      if (
        attempt.reads.length >= 6 ||
        logical + requests.length > 8 ||
        Buffer.byteLength(body) > 32768
      ) {
        budgetFailed = true;
        throw failure('budget-exhausted');
      }
      const timing = {
        label,
        methods: requests.map((request) => request.method),
        queuedAtMs: elapsed(),
        paceStartMs: null,
        paceEndMs: null,
        fetchStartMs: null,
        headersAtMs: null,
        bodyParsedAtMs: null,
        retainedAtMs: null,
        sendFinishedAtMs: null,
        sendOutcome: null,
      };
      attempt.diagnosticTimings.push(timing);
      try {
        mark(timing, 'paceStartMs');
        for (const _request of requests) {
          await bounded(
            Promise.resolve().then(() => pace(pinnedEndpoint, deadline)),
          );
          deadline.throwIfAborted();
        }
        mark(timing, 'paceEndMs');
        logical += requests.length;
        const read = {
          index: attempt.reads.length,
          methods: requests.map((r) => r.method),
          logicalMethods: requests.length,
          requestSha256: hash(body),
        };
        attempt.reads.push(read);
        timingForRead.set(read, timing);
        keep(`${read.index}.request.json`, body);
        mark(timing, 'fetchStartMs');
        const pending = Promise.resolve()
          .then(() =>
            fetcher(pinnedEndpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
              signal: deadline,
              redirect: 'error',
              cache: 'no-store',
            }),
          )
          .then((response) => {
            responses.add(response);
            if (deadline.aborted) cancel(response);
            return response;
          });
        const response = await bounded(pending);
        mark(timing, 'headersAtMs');
        read.httpStatus = response.status;
        if (response.status === 429) rateLimited = true;
        if (!response.ok) {
          cancel(response);
          timing.sendOutcome = rateLimited ? 'rate-limited' : 'http-refused';
          throw failure(
            (rateLimited ? 'rate-limited' : 'http-refused') +
              ' status ' +
              response.status,
          );
        }
        timing.sendOutcome = 'headers-received';
        return { response, read };
      } catch (error) {
        if (!timingClosed && !timing.sendOutcome)
          timing.sendOutcome = deadline.aborted
            ? 'interrupted'
            : 'send-refused';
        throw error;
      } finally {
        mark(timing, 'sendFinishedAtMs');
      }
    }
    function retain(read, capture) {
      if (
        !capture ||
        !(capture.rawBody instanceof Uint8Array) ||
        hash(capture.rawBody) !== capture.rawSha256 ||
        capture.byteLength !== capture.rawBody.byteLength
      )
        throw failure('capture-integrity-refused');
      keep(`${read.index}.response.bin`, capture.rawBody);
      const timing = timingForRead.get(read);
      if (timing) mark(timing, 'retainedAtMs');
      Object.assign(read, {
        responseSha256: capture.rawSha256,
        responseBytes: capture.byteLength,
      });
    }
    async function rpc(method, params) {
      const id = `native:${index}:${attempt.reads.length}`;
      const { response, read } = await send(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        `${phase}:${method}`,
      );
      const capture = await bounded(
        adapter.readJitoSimulationPayload(response.body, deadline, 4194304),
      );
      const timing = timingForRead.get(read);
      if (timing) mark(timing, 'bodyParsedAtMs');
      retain(read, capture);
      const value = capture.value;
      const replies = Array.isArray(value) ? value : [value];
      if (
        replies.some(
          (reply) =>
            reply && typeof reply === 'object' && reply.error?.code === 429n,
        )
      ) {
        rateLimited = true;
        throw failure('rate-limited');
      }
      if (
        !value ||
        value.jsonrpc !== '2.0' ||
        value.id !== id ||
        value.error ||
        !Object.hasOwn(value, 'result')
      )
        throw failure('rpc-refused');
      return value.result;
    }
    try {
      if ((await rpc('getGenesisHash', [])) !== GENESIS)
        throw failure('network-refused');
      const latest = await rpc('getLatestBlockhash', [
        { commitment: 'confirmed' },
      ]);
      attempt.originalFloor = slot(latest.context.slot);
      const accounts = await rpc('getMultipleAccounts', [
        REFERENCES,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          minContextSlot: attempt.originalFloor,
        },
      ]);
      attempt.accountSlot = slot(accounts.context.slot);
      inWindow(attempt.accountSlot);
      if (
        !Array.isArray(accounts.value) ||
        accounts.value.length !== REFERENCES.length
      )
        throw failure('reference-refused');
      const eligible = (a) =>
        a?.owner === SYSTEM &&
        a.executable === false &&
        a.data?.length === 2 &&
        a.data[0] === '' &&
        a.data[1] === 'base64' &&
        typeof a.lamports === 'bigint' &&
        a.lamports > 1000000n;
      const payerIndex =
        pinnedPayer === undefined
          ? accounts.value.findIndex(eligible)
          : REFERENCES.indexOf(pinnedPayer);
      if (payerIndex < 0 || !eligible(accounts.value[payerIndex]))
        throw failure('reference-refused');
      pinnedPayer ??= REFERENCES[payerIndex];
      attempt.payer = pinnedPayer;
      const packets = Object.freeze(
        packetsFor(pinnedPayer, latest.value.blockhash),
      );
      attempt.packetHashes = packets.map((p) =>
        hash(Buffer.from(p.transaction, 'base64')),
      );
      keep(
        'input-private.json',
        encoded({
          packets,
          originalFloor: attempt.originalFloor,
          accountSlot: attempt.accountSlot,
          payer: pinnedPayer,
        }),
      );
      phase = 'runtime';
      const runtimeReads = [];
      const result = await bounded(
        (profile === 'prefee'
          ? adapter.collectJitoCoherentPrefeeAttempt
          : adapter.collectJitoCoherentSimulationAttempt)({
          packets,
          minimumSlot: attempt.originalFloor,
          minimumReadSlot: attempt.accountSlot,
          feeIdPrefix: `native-fees:${index}`,
          simulationRpcId: `native-exact:${index}`,
          verifySignatures: false,
          signal: deadline,
          transport: async (request) => {
            if (
              request.signal.aborted ||
              !(
                profile === 'prefee'
                  ? ['discovery-batch', 'exact']
                  : ['discovery', 'batch']
              ).includes(request.phase)
            )
              throw failure('request-refused');
            const rows = JSON.parse(request.body);
            const members = Array.isArray(rows) ? rows : [rows];
            if (
              members.length !== request.methodCount ||
              members.length !==
                (['batch', 'discovery-batch'].includes(request.phase) ? 3 : 1)
            )
              throw failure('request-refused');
            const simulations = members.filter(
              (m) => m.method === 'simulateBundle',
            );
            if (
              simulations.length !== 1 ||
              members.filter((m) => m.method === 'getFeeForMessage').length !==
                (['batch', 'discovery-batch'].includes(request.phase) ? 2 : 0)
            )
              throw failure('request-refused');
            const params = simulations[0].params;
            if (
              encoded(params[0].encodedTransactions) !==
                encoded(packets.map((p) => p.transaction)) ||
              params[1].skipSigVerify !== true ||
              params[1].replaceRecentBlockhash !== false
            )
              throw failure('request-refused');
            const read = await send(request.body, `runtime:${request.phase}`);
            runtimeReads.push({ phase: request.phase, read: read.read });
            return read.response;
          },
        }),
      );
      if (result.discovery && profile === 'legacy')
        retain(
          runtimeReads.find((r) => r.phase === 'discovery').read,
          result.discovery,
        );
      if (result.batch?.rawResponse) {
        const parent = result.batch.rawResponse;
        retain(
          runtimeReads.find(
            (r) =>
              r.phase === (profile === 'prefee' ? 'discovery-batch' : 'batch'),
          ).read,
          parent,
        );
        const members = (
          result.batch.status === 'captured' ? result.batch.members : []
        ).map((m) => {
          if (
            hash(parent.rawBody.slice(m.start, m.end)) !== m.sha256 ||
            hash(m.rawBody) !== m.sha256
          )
            throw failure('member-integrity-refused');
          return { id: m.id, start: m.start, end: m.end, sha256: m.sha256 };
        });
        keep(
          'batch-members.json',
          encoded({
            parentSha256: parent.rawSha256,
            members,
            feeProjectionIsDerivedNotWireBody: true,
            ...(profile === 'prefee' && result.discovery && members.length
              ? {
                  discoveryMember: {
                    kind: 'derived-batch-member-not-wire-response',
                    ...members.at(-1),
                  },
                }
              : {}),
          }),
        );
      }
      if (profile === 'prefee' && result.simulation?.rawResponse)
        retain(
          runtimeReads.find((r) => r.phase === 'exact').read,
          result.simulation.rawResponse,
        );
      if (result.feeProjection?.rawBody)
        keep('derived-fees-not-wire.bin', result.feeProjection.rawBody);
      if (result.sentSimulationBody)
        keep('exact-simulation-member-request.json', result.sentSimulationBody);
      if (result.reason === 'rate-limited') rateLimited = true;
      if (Object.keys(authority).some((key) => result[key] !== false))
        throw failure('authority-refused');
      if (result.status !== 'captured') {
        attempt.reason = [
          'interrupted',
          'transport-unavailable',
          'rate-limited',
          'http-refused',
          'fees-refused',
          'simulation-refused',
          'bank-unavailable',
          'request-binding-differs',
          'plan-refused',
        ].includes(result.reason)
          ? result.reason
          : 'runtime-refused';
        if (typeof result.detail === 'string') attempt.detail = result.detail;
        if (process.env.JITO_DEBUG)
          console.log('KEYS', Object.keys(result).join(','));
      } else {
        const bank = result.fees.simulationBankSlot;
        inWindow(bank);
        if (
          result.simulation.frames.slot !== bank ||
          result.simulation.frames.frames.length !== 2 ||
          result.fees.fees.length !== 2 ||
          result.fees.fees.some(
            (f) =>
              f.slot !== bank ||
              f.slot < attempt.originalFloor ||
              f.slot - attempt.originalFloor > 32 ||
              String(f.feeLamports) !== '5000',
          )
        )
          throw failure(
            'bank-or-fee-refused' +
              ' bank=' +
              bank +
              ' account=' +
              attempt.accountSlot +
              ' frames=' +
              result.simulation.frames.frames.length +
              '@' +
              result.simulation.frames.slot +
              ' fees=' +
              result.fees.fees
                .map((f) => f.slot + ':' + f.feeLamports)
                .join(','),
          );
        attempt.bank = bank;
        phase = 'final-genesis';
        if ((await rpc('getGenesisHash', [])) !== GENESIS)
          throw failure('network-refused');
        attempt.status = 'captured';
        attempt.reason = 'native-profile-only';
        attempt.nativeCaptured = true;
      }
    } catch (error) {
      attempt.reason = rateLimited
        ? 'rate-limited'
        : budgetFailed
          ? 'budget-exhausted'
          : deadline.aborted
            ? 'interrupted'
            : (safeFailures.get(error) ?? 'setup-or-transport-failed');
    } finally {
      timingClosed = true;
      owner.abort();
      for (const response of responses) cancel(response);
    }
    attempt.logicalMethods = logical;
    attempt.httpRequests = attempt.reads.length;
    keep('outcome.json', encoded(attempt));
    saveReport();
    if (
      rateLimited ||
      budgetFailed ||
      attempt.reason === 'interrupted' ||
      phase === 'setup' ||
      [
        'setup-or-transport-failed',
        'authority-refused',
        'network-refused',
        'capture-integrity-refused',
        'member-integrity-refused',
        'request-refused',
      ].includes(attempt.reason)
    ) {
      report.stoppedAfter = index + 1;
      break;
    }
  }
  report.completedPlannedAttempts = report.attempts.length === 3;
  report.nativeCapturedCount = report.attempts.filter(
    (a) => a.nativeCaptured,
  ).length;
  // Three captures is the provider claim; the other flags stay false because
  // economics, runtime privileges and signing are separate gates.
  report.providerQualified =
    providerMode === 'default' &&
    profile === 'legacy' &&
    report.nativeCapturedCount === 3;
  if (profile === 'prefee')
    report.nativeProfileConsistent = report.nativeCapturedCount === 3;
  saveReport();
  return report;
}

const ENTRY_NAME = 'native-qualification-entry.ts';
const ENTRY_SOURCE =
  "export {collectJitoCoherentSimulationAttempt} from './lib/jito-coherent-simulation-attempt';export {collectJitoCoherentPrefeeAttempt} from './lib/jito-coherent-prefee-attempt';export {readJitoSimulationPayload} from './lib/jito-simulation-json';export {paceWalletRpc} from './lib/wallet-rpc-pacing';";

export function nativeSourceIdentity(
  inputs,
  rootDir,
  frozenSources = new Map(),
  readSource = readFileSync,
) {
  let entrySeen = false;
  const seen = new Set();
  const sources = Object.keys(inputs)
    .sort()
    .map((path) => {
      if (path === ENTRY_NAME) {
        entrySeen = true;
        if (inputs[path].bytes !== Buffer.byteLength(ENTRY_SOURCE))
          throw failure('source-identity-refused');
        return {
          path,
          kind: 'explicit-virtual-entry',
          sha256: hash(ENTRY_SOURCE),
        };
      }
      const absolute = resolve(rootDir, path);
      const inside = relative(rootDir, absolute);
      if (
        !inside ||
        inside === '..' ||
        inside.startsWith(`..${sep}`) ||
        !existsSync(absolute)
      )
        throw failure('source-identity-refused');
      const frozen = frozenSources.get(absolute);
      if (
        !frozen ||
        !(frozen.bytes instanceof Uint8Array) ||
        hash(frozen.bytes) !== frozen.sha256
      )
        throw failure('source-identity-refused');
      const bytes = readSource(absolute);
      if (
        inputs[path].bytes !== frozen.bytes.byteLength ||
        hash(bytes) !== frozen.sha256
      )
        throw failure('source-identity-refused');
      seen.add(absolute);
      return { path, kind: 'source-file', sha256: frozen.sha256 };
    });
  if (!entrySeen || sources.length < 2 || seen.size !== frozenSources.size)
    throw failure('source-identity-refused');
  return sources;
}

/** Offline build preparation; does not read configuration or perform provider requests. */
export async function compileNativeAdapter({
  folder,
  persist,
  rootDir = process.cwd(),
}) {
  const { build } = await import('esbuild');
  const artifact = resolve(folder, 'production-adapter.mjs');
  const frozenSources = new Map();
  const built = await build({
    absWorkingDir: rootDir,
    stdin: {
      contents: ENTRY_SOURCE,
      resolveDir: rootDir,
      sourcefile: ENTRY_NAME,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: [
      {
        name: 'frozen-production-inputs',
        setup(compiler) {
          compiler.onLoad({ filter: /.*/, namespace: 'file' }, (args) => {
            const absolute = resolve(args.path);
            const inside = relative(resolve(rootDir, 'lib'), absolute);
            if (
              !inside ||
              inside === '..' ||
              inside.startsWith(`..${sep}`) ||
              !absolute.endsWith('.ts') ||
              frozenSources.has(absolute)
            )
              throw failure('source-identity-refused');
            const bytes = Uint8Array.from(readFileSync(absolute));
            const snapshot = {
              bytes: Uint8Array.from(bytes),
              sha256: hash(bytes),
            };
            frozenSources.set(absolute, snapshot);
            return {
              contents: bytes,
              loader: 'ts',
              resolveDir: dirname(absolute),
            };
          });
        },
      },
    ],
    outfile: artifact,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  if (
    built.outputFiles.length !== 1 ||
    resolve(built.outputFiles[0].path) !== artifact
  )
    throw failure('source-identity-refused');
  // Keep the compiler output in memory, then persist exactly those bytes from
  // this process. Some Windows setups deny filesystem writes by the esbuild
  // subprocess even when the caller can write in the same directory.
  writeFileSync(artifact, built.outputFiles[0].contents, { flag: 'wx' });
  const identity = {
    artifactSha256: hash(readFileSync(artifact)),
    inputs: nativeSourceIdentity(built.metafile.inputs, rootDir, frozenSources),
  };
  for (const [absolute, frozen] of frozenSources)
    persist(
      `source-snapshot/${relative(rootDir, absolute).split(sep).join('/')}`,
      frozen.bytes,
    );
  persist('source-identity.json', encoded(identity));
  const adapter = await import(pathToFileURL(artifact).href);
  if (
    typeof adapter.collectJitoCoherentSimulationAttempt !== 'function' ||
    typeof adapter.collectJitoCoherentPrefeeAttempt !== 'function' ||
    typeof adapter.readJitoSimulationPayload !== 'function' ||
    typeof adapter.paceWalletRpc !== 'function'
  )
    throw failure('source-identity-refused');
  return { adapter, identity };
}

export async function main(args = process.argv.slice(2)) {
  if (
    ![2, 3, 4].includes(args.length) ||
    new Set(args).size !== args.length ||
    !args.includes('--live-readonly') ||
    args.filter((a) => a.startsWith('--output-dir=')).length !== 1 ||
    args.some(
      (a) =>
        !['--live-readonly', '--prefee', '--helius'].includes(a) &&
        !a.startsWith('--output-dir='),
    )
  )
    throw failure('arguments-refused');
  const folder = resolve(
    args.find((a) => a.startsWith('--output-dir=')).slice(13),
  );
  const base = resolve('work/release-qa');
  const inside = relative(base, folder);
  if (
    !inside ||
    inside.startsWith(`..${sep}`) ||
    inside === '..' ||
    resolve(base, inside) !== folder ||
    existsSync(folder)
  )
    throw failure('output-refused');
  mkdirSync(folder, { recursive: true });
  const persist = (name, bytes) => {
    const path = resolve(folder, name);
    if (!path.startsWith(folder + sep)) throw failure('output-refused');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  persist(
    'startup.json',
    encoded({
      profile: args.includes('--prefee')
        ? 'unsigned-native-prefee-zero-transfer-only'
        : 'unsigned-native-zero-transfer-only',
      plannedAttempts: 3,
      status: 'starting',
      ...authority,
    }),
  );
  try {
    if (Number(process.versions.node.split('.')[0]) !== 24)
      throw failure('node-version-refused');
    const local = parseEnv(readFileSync('.env.local', 'utf8'));
    // Alchemy is preferred; the public endpoint keeps the campaign runnable
    // without one. The receipt records which variable supplied it.
    const providerMode = args.includes('--helius') ? 'helius' : 'default';
    const endpoint = selectNativeEndpoint(local, providerMode);
    const interval = local.SOLANA_RPC_MIN_INTERVAL_MS;
    if (interval !== undefined) {
      if (
        interval !== '' &&
        (!/^\d{1,4}$/.test(interval) || Number(interval) > 2000)
      )
        throw failure(
          'configuration-refused: invalid SOLANA_RPC_MIN_INTERVAL_MS',
        );
      process.env.SOLANA_RPC_MIN_INTERVAL_MS = interval;
    }
    const { adapter } = await compileNativeAdapter({ folder, persist });
    const result = await runNativeJitoCampaign({
      endpoint,
      adapter,
      fetcher: fetch,
      persist,
      profile: args.includes('--prefee') ? 'prefee' : 'legacy',
      providerMode,
    });
    console.log(
      encoded({
        attempts: result.attempts.length,
        captured: result.nativeCapturedCount,
        completed: result.completedPlannedAttempts,
        ...authority,
      }),
    );
    return result;
  } catch (error) {
    // The reason alone says nothing; keep the app-authored message. These are
    // our own refusal strings, not provider bodies, so no credential leaks.
    const detail =
      error instanceof Error ? error.message.slice(0, 400) : 'unknown';
    persist(
      'startup-failure.json',
      encoded({ reason: 'setup-or-campaign-failed', detail, ...authority }),
    );
    throw failure('setup-or-campaign-failed: ' + detail);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch(() => {
    console.error(
      'Native read-only campaign refused. Inspect retained sanitized receipts.',
    );
    process.exitCode = 1;
  });
