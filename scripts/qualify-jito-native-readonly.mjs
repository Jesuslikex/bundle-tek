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

export function validateEndpoint(value) {
  if (!value)
    throw failure(
      'configuration-refused: set SOLANA_HOLDER_RPC_URL or SOLANA_MAINNET_RPC_URL',
    );
  try {
    const url = new URL(value);
    // Alchemy is the measured profile; the public endpoint is accepted so the
    // campaign can run at all, and the receipt records which host was used.
    if (
      url.protocol !== 'https:' ||
      !['solana-mainnet.g.alchemy.com', 'api.mainnet-beta.solana.com'].includes(
        url.hostname,
      ) ||
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
}) {
  const pinnedEndpoint = validateEndpoint(endpoint);
  if (typeof pace !== 'function')
    throw failure('configuration-refused: adapter has no pacing function');
  if (attemptTimeoutMs !== 45000)
    throw failure('configuration-refused: attempt timeout must be 45000 ms');
  const report = {
    profile: 'unsigned-native-zero-transfer-only',
    endpointHost: new URL(pinnedEndpoint).hostname,
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
    const attempt = {
      index: index + 1,
      status: 'refused',
      reason: 'setup-failed',
      reads: [],
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
    async function send(body) {
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
      for (const _request of requests) {
        await bounded(
          Promise.resolve().then(() => pace(pinnedEndpoint, deadline)),
        );
        deadline.throwIfAborted();
      }
      logical += requests.length;
      const read = {
        index: attempt.reads.length,
        methods: requests.map((r) => r.method),
        logicalMethods: requests.length,
        requestSha256: hash(body),
      };
      attempt.reads.push(read);
      keep(`${read.index}.request.json`, body);
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
      read.httpStatus = response.status;
      if (response.status === 429) rateLimited = true;
      if (!response.ok) {
        cancel(response);
        throw failure(
          (rateLimited ? 'rate-limited' : 'http-refused') +
            ' status ' +
            response.status,
        );
      }
      return { response, read };
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
      Object.assign(read, {
        responseSha256: capture.rawSha256,
        responseBytes: capture.byteLength,
      });
    }
    async function rpc(method, params) {
      const id = `native:${index}:${attempt.reads.length}`;
      const { response, read } = await send(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      );
      const capture = await bounded(
        adapter.readJitoSimulationPayload(response.body, deadline, 4194304),
      );
      retain(read, capture);
      const value = capture.value;
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
        adapter.collectJitoCoherentSimulationAttempt({
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
              !['discovery', 'batch'].includes(request.phase)
            )
              throw failure('request-refused');
            const rows = JSON.parse(request.body);
            const members = Array.isArray(rows) ? rows : [rows];
            if (
              members.length !== request.methodCount ||
              members.length !== (request.phase === 'batch' ? 3 : 1)
            )
              throw failure('request-refused');
            const simulations = members.filter(
              (m) => m.method === 'simulateBundle',
            );
            if (
              simulations.length !== 1 ||
              members.filter((m) => m.method === 'getFeeForMessage').length !==
                (request.phase === 'batch' ? 2 : 0)
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
            const read = await send(request.body);
            runtimeReads.push({ phase: request.phase, read: read.read });
            return read.response;
          },
        }),
      );
      if (result.discovery)
        retain(
          runtimeReads.find((r) => r.phase === 'discovery').read,
          result.discovery,
        );
      if (result.batch?.rawResponse) {
        const parent = result.batch.rawResponse;
        retain(runtimeReads.find((r) => r.phase === 'batch').read, parent);
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
          }),
        );
      }
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
    if (process.env.JITO_DEBUG) console.log('KEYS', Object.keys(result).join(','));
      } else {
        const bank = result.fees.simulationBankSlot;
        inWindow(bank);
        if (
          bank < attempt.accountSlot ||
          result.simulation.frames.slot !== bank ||
          result.simulation.frames.frames.length !== 2 ||
          result.fees.fees.length !== 2 ||
          result.fees.fees.some(
            (f) => f.slot !== bank || String(f.feeLamports) !== '5000',
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
          result.fees.fees.map((f) => f.slot + ':' + f.feeLamports).join(','),
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
  saveReport();
  return report;
}

const ENTRY_NAME = 'native-qualification-entry.ts';
const ENTRY_SOURCE =
  "export {collectJitoCoherentSimulationAttempt} from './lib/jito-coherent-simulation-attempt';export {readJitoSimulationPayload} from './lib/jito-simulation-json';export {paceWalletRpc} from './lib/wallet-rpc-pacing';";

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
    metafile: true,
    logLevel: 'silent',
  });
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
    typeof adapter.readJitoSimulationPayload !== 'function' ||
    typeof adapter.paceWalletRpc !== 'function'
  )
    throw failure('source-identity-refused');
  return { adapter, identity };
}

export async function main(args = process.argv.slice(2)) {
  if (
    args.length !== 2 ||
    !args.includes('--live-readonly') ||
    !args.some((a) => a.startsWith('--output-dir='))
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
      profile: 'unsigned-native-zero-transfer-only',
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
    const endpoint = validateEndpoint(
      local.SOLANA_HOLDER_RPC_URL ?? local.SOLANA_MAINNET_RPC_URL,
    );
    const interval = local.SOLANA_RPC_MIN_INTERVAL_MS;
    if (interval !== undefined) {
      if (
        interval !== '' &&
        (!/^\d{1,4}$/.test(interval) || Number(interval) > 2000)
      )
        throw failure('configuration-refused: invalid SOLANA_RPC_MIN_INTERVAL_MS');
      process.env.SOLANA_RPC_MIN_INTERVAL_MS = interval;
    }
    const { adapter } = await compileNativeAdapter({ folder, persist });
    const result = await runNativeJitoCampaign({
      endpoint,
      adapter,
      fetcher: fetch,
      persist,
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