// One quote GET, disposable local SQL, no provider order or wallet authority.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const sources = [
  'scripts/qualify-exchange-provider.mjs',
  'package.json',
  'package-lock.json',
  'lib/exchange-funding-quote.ts',
  'lib/exchange-funding-review.ts',
  'lib/exchange-order-service.ts',
  'lib/exchange-order-review.ts',
  'lib/exchange-order-history-service.ts',
  'lib/exchange-order-history.ts',
  'lib/exchange-ui-request.ts',
  'lib/funding-plan.ts',
  'test/exchange-order-review-api-fixture.ts',
  'test/exchange-funding-review-fixture.ts',
  'db/turso.ts',
  'drizzle/0012_messy_zzzax.sql',
  'drizzle/0103_exchange_funding_quotes.sql',
  'drizzle/0104_exchange_funding_orders.sql',
  'drizzle/0106_exchange_payout_receipts.sql',
];
const refusal = (code) =>
  Object.assign(new Error('Qualification refused.'), { code });

export async function qualifyExchangeProvider({
  liveReadOnly = false,
  payoutSol,
  key,
  fetchImpl,
  root = process.cwd(),
  runtimeVersion = process.versions.node,
  argumentsValid = true,
} = {}) {
  root = resolve(root);
  const folder = join(
    root,
    'work',
    'exchange-provider-qualification-' +
      new Date().toISOString().replaceAll(/[:.]/g, '-') +
      '-' +
      randomUUID(),
  );
  await mkdir(folder, { recursive: true });
  const receiptPath = join(folder, 'receipt.json');
  const receipt = {
    format: 'exchange-provider-readonly-qualification-v1',
    checkedAt: new Date().toISOString(),
    stage: 'configuration',
    passed: false,
    liveQuoteQualified: false,
    refusal: null,
    httpStatus: null,
    serviceStatus: null,
    providerRequests: 0,
    blockedRequests: 0,
    networkMode: fetchImpl ? 'injected-synthetic' : 'live-readonly',
    runtimeVersion,
    sourceFiles: {},
    sourceUnchanged: false,
    executedBundleSha256: null,
    quote: null,
    reviewPrepared: false,
    reviewReloadMatched: false,
    ownershipEvidence: 'synthetic-fixture-only',
    database: 'disposable-local-memory',
    productionConfigChanged: false,
    providerOrders: 0,
    approvals: 0,
    deposits: 0,
    signatures: 0,
    broadcasts: 0,
    orderCreationAllowed: false,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  };
  let fixture, lib;
  try {
    if (!argumentsValid) throw refusal('arguments-refused');
    if (!liveReadOnly) throw refusal('readonly-intent-required');
    if (!/^24\.\d+\.\d+$/.test(runtimeVersion))
      throw refusal('runtime-mismatch');
    if (
      typeof payoutSol !== 'string' ||
      !/^(0|[1-9]\d{0,9})(\.\d{1,9})?$/.test(payoutSol)
    )
      throw refusal('payout-amount-invalid');
    if (
      !key ||
      typeof key !== 'string' ||
      key.length > 4096 ||
      /[\p{Cc}\s]/u.test(key)
    )
      throw refusal('provider-key-missing-or-invalid');
    receipt.stage = 'build';
    for (const name of sources)
      receipt.sourceFiles[name] = hash(await readFile(join(root, name)));
    const bundle = join(folder, 'reader.mjs'),
      { build } = await import('esbuild');
    const built = await build({
      stdin: {
        contents: `export {previewOwnedExchangeFunding,readOwnedExchangeFundingQuote,ExchangeFundingError} from './lib/exchange-funding-quote';export {prepareOwnedExchangeOrderReview} from './lib/exchange-order-service';export {readOwnedExchangeOrderHistory} from './lib/exchange-order-history-service';export {exchangeUiRequest} from './lib/exchange-ui-request';export {exchangeSolLamports,exchangeSolDisplay} from './lib/exchange-funding-review';export {validateFunding} from './lib/funding-plan';export {exchangeOrderReviewApiFixture} from './test/exchange-order-review-api-fixture';`,
        resolveDir: root,
        sourcefile: 'exchange-readonly-qualification.ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      outfile: bundle,
      write: false,
      logLevel: 'silent',
    });
    if (
      built.outputFiles.length !== 1 ||
      resolve(built.outputFiles[0].path) !== resolve(bundle)
    )
      throw refusal('build-unavailable');
    await writeFile(bundle, built.outputFiles[0].contents, { flag: 'wx' });
    receipt.executedBundleSha256 = hash(await readFile(bundle));
    lib = await import(pathToFileURL(bundle).href);
    receipt.stage = 'validation';
    let payoutRaw;
    try {
      payoutRaw = lib.exchangeSolLamports(payoutSol);
    } catch {
      throw refusal('payout-amount-invalid');
    }
    const normalized = lib.exchangeSolDisplay(payoutRaw);
    fixture = await lib.exchangeOrderReviewApiFixture();
    const document = lib.validateFunding({
      ...fixture.base.plan.document,
      recipients: [{ address: fixture.refund.address, amount: normalized }],
    });
    await fixture.db
      .prepare('UPDATE funding_plans SET document=? WHERE owner_id=? AND id=?')
      .bind(JSON.stringify(document), 'alice', fixture.base.plan.id)
      .run();
    const fetcher = async (url, init) => {
      const parsed = new URL(url),
        query = parsed.searchParams;
      if (
        receipt.providerRequests ||
        init?.method !== 'GET' ||
        parsed.origin !== 'https://api.changenow.io' ||
        parsed.pathname !== '/v2/private-transfer/estimated-amount' ||
        query.size !== 3 ||
        query.get('currency') !== 'sol' ||
        query.get('network') !== 'sol' ||
        lib.exchangeSolLamports(query.get('toAmount')) !== payoutRaw ||
        init.body !== undefined ||
        new Headers(init.headers).get('x-changenow-api-key') !== key
      ) {
        receipt.blockedRequests++;
        throw refusal('transport-boundary-refused');
      }
      receipt.providerRequests++;
      return lib.exchangeUiRequest(
        init.signal,
        async (signal) => {
          const response = await (fetchImpl ?? fetch)(url, {
            ...init,
            signal,
            redirect: 'manual',
            cache: 'no-store',
          });
          signal.throwIfAborted();
          receipt.httpStatus = response.status;
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            return new Response(null, { status: response.status });
          }
          const reader = response.body?.getReader();
          if (!reader) throw refusal('provider-body-unavailable');
          const chunks = [];
          let size = 0;
          const cancel = () => {
            void reader.cancel().catch(() => {});
          };
          signal.addEventListener('abort', cancel, { once: true });
          try {
            while (true) {
              signal.throwIfAborted();
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 65536) throw refusal('provider-body-too-large');
              chunks.push(part.value);
            }
            signal.throwIfAborted();
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return new Response(bytes, {
              status: response.status,
              headers: { 'content-type': 'application/json' },
            });
          } finally {
            signal.removeEventListener('abort', cancel);
            cancel();
            reader.releaseLock();
          }
        },
        15000,
      );
    };
    receipt.stage = 'quote';
    const quote = await lib.exchangeUiRequest(
      new AbortController().signal,
      (signal) =>
        lib.previewOwnedExchangeFunding(
          fixture.db,
          'alice',
          {
            planId: fixture.base.plan.id,
            revision: fixture.base.plan.revision,
            funderRevision: fixture.base.funder.revision,
            minimumPayoutLamports: payoutRaw,
          },
          signal,
          { key, enabled: true, fetchImpl: fetcher },
        ),
      30000,
    );
    receipt.quote = {
      depositLamports: quote.depositLamports,
      expectedPayoutLamports: quote.expectedPayoutLamports,
      providerCostLamports: quote.providerCostLamports,
      distributionTotalLamports: quote.distributionTotalLamports,
      expiresAt: quote.expiresAt,
      providerNotePresent: Boolean(quote.providerWarning),
    };
    receipt.stage = 'local-review';
    const review = await lib.prepareOwnedExchangeOrderReview(
      fixture.db,
      'alice',
      { quoteId: quote.id, refund: fixture.refund },
    );
    receipt.reviewPrepared = true;
    const restoredQuote = await lib.readOwnedExchangeFundingQuote(
        fixture.db,
        'alice',
        quote.id,
      ),
      restored = await lib.readOwnedExchangeOrderHistory(
        fixture.db,
        'alice',
        review.terms.id,
      );
    if (
      JSON.stringify(restoredQuote) !== JSON.stringify(quote) ||
      JSON.stringify(restored.quote) !== JSON.stringify(quote) ||
      restored.refundAddress !== fixture.refund.address ||
      restored.approved ||
      restored.providerReferenceRetained ||
      restored.orderCreationAllowed ||
      restored.fundingAllowed ||
      restored.signingAllowed ||
      restored.executionAllowed
    )
      throw refusal('local-review-binding-refused');
    for (const table of [
      'exchange_funding_order_approvals',
      'exchange_funding_order_attempts',
      'exchange_funding_order_references',
      'exchange_funding_order_observations',
      'exchange_funding_payout_receipts',
    ])
      if (
        Number(
          (await fixture.client.execute('SELECT count(*) AS n FROM ' + table))
            .rows[0].n,
        ) !== 0
      )
        throw refusal('unexpected-local-authority-record');
    receipt.reviewReloadMatched = true;
    receipt.stage = 'complete';
    receipt.passed =
      receipt.providerRequests === 1 && receipt.blockedRequests === 0;
  } catch (error) {
    const known = [
      'arguments-refused',
      'readonly-intent-required',
      'runtime-mismatch',
      'payout-amount-invalid',
      'provider-key-missing-or-invalid',
      'transport-boundary-refused',
      'provider-body-unavailable',
      'provider-body-too-large',
      'local-review-binding-refused',
      'unexpected-local-authority-record',
    ];
    receipt.refusal = known.includes(error?.code)
      ? error.code
      : receipt.stage === 'quote'
        ? 'provider-or-quote-refused'
        : receipt.stage === 'build'
          ? 'build-unavailable'
          : 'local-qualification-refused';
    if (
      lib &&
      error instanceof lib.ExchangeFundingError &&
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status <= 599
    )
      receipt.serviceStatus = error.status;
  } finally {
    fixture?.client.close();
    if (Object.keys(receipt.sourceFiles).length) {
      receipt.sourceUnchanged = true;
      for (const [name, digest] of Object.entries(receipt.sourceFiles)) {
        try {
          if (hash(await readFile(join(root, name))) !== digest)
            receipt.sourceUnchanged = false;
        } catch {
          receipt.sourceUnchanged = false;
        }
      }
      if (!receipt.sourceUnchanged) {
        receipt.passed = false;
        receipt.refusal = 'source-changed';
      }
    }
    receipt.liveQuoteQualified =
      receipt.passed && receipt.networkMode === 'live-readonly';
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
    });
  }
  return { receipt, path: relative(root, receiptPath) };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2),
    payout = args.filter((arg) => arg.startsWith('--payout-sol='));
  const valid =
    payout.length === 1 &&
    args.filter((arg) => arg === '--live-readonly').length === 1 &&
    args.length === 2;
  try {
    const result = await qualifyExchangeProvider({
      liveReadOnly: args.includes('--live-readonly'),
      payoutSol: payout[0]?.slice('--payout-sol='.length),
      key: process.env.CHANGENOW_API_KEY,
      argumentsValid: valid,
    });
    console.log(
      JSON.stringify({
        receipt: result.path,
        passed: result.receipt.passed,
        stage: result.receipt.stage,
        refusal: result.receipt.refusal,
        providerRequests: result.receipt.providerRequests,
      }),
    );
    process.exitCode = result.receipt.passed ? 0 : 2;
  } catch {
    console.error(
      'Qualification could not retain local evidence. No retry was started.',
    );
    process.exitCode = 2;
  }
}
