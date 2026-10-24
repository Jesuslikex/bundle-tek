import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  jitoRawResponseFixture,
  rawNumberToken,
} from '../test/jito-raw-response-fixture';
import { verifyJitoBundleEconomicObservation } from './jito-bundle-economics';
import { readJitoSimulationResponse as read } from './jito-simulation-response';
const digest = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');

for (const side of ['Buy', 'Sell'] as const)
  for (const token2022 of [false, true])
    for (const lookup of [false, true])
      it(`projects retained raw ${side}/2022=${token2022}/ALT=${lookup} evidence into the actual frame and economic verifiers`, async () => {
        const f = await jitoRawResponseFixture({
          side,
          token2022,
          lookup,
          wallets: 4,
        });
        const raw = f.wire();
        const output = await read({
          ...f.policy,
          body: f.body(),
          signal: new AbortController().signal,
        });
        expect(output.status).toBe('admitted');
        if (output.status !== 'admitted') throw Error(output.reason);
        expect(output.rawResponse.rawSha256).toBe(digest(raw));
        expect(Buffer.from(output.rawResponse.rawBody).toString()).toBe(raw);
        expect(output.rawResponse.byteLength).toBe(Buffer.byteLength(raw));
        expect(output.request.sha256).toBe(digest(output.request.body));
        const request = JSON.parse(output.request.body);
        expect(request.params[1].simulationBank).toEqual({ slot: 101 });
        expect(request.params[1].replaceRecentBlockhash).toBe(false);
        expect(request.params[1].skipSigVerify).toBe(true);
        expect(output.frames.frames).toHaveLength(5);
        expect(output).toMatchObject({
          frameIntegrityVerified: true,
          providerQualified: false,
          sourceAuthenticated: false,
          signingAllowed: false,
          executionAllowed: false,
          economicOutputVerified: false,
          signatureVerified: false,
          altStateVerified: false,
        });
        const economic = await verifyJitoBundleEconomicObservation({
          ...f.fixture,
          result: output.normalizedResult,
        });
        expect(economic.outcomes.map((o) => o.observedOutputRaw)).toEqual(
          Array(4).fill(side === 'Buy' ? '1000' : '1000000'),
        );
        expect(economic.signingAllowed).toBe(false);
      });

type F = Awaited<ReturnType<typeof jitoRawResponseFixture>>;
const first = (f: F) =>
  f.envelope.result.value.transactionResults[0] as unknown as Record<
    string,
    unknown
  >;
const record = (v: unknown) => v as Record<string, unknown>;
const rawAccount = (f: F) =>
  record((first(f).preExecutionAccounts as unknown[])[0]);
async function refusal(change: (f: F) => void, reason?: string) {
  const f = await jitoRawResponseFixture({
    lookup: true,
    token2022: true,
    wallets: 2,
  });
  change(f);
  const raw = f.wire();
  const output = await read({
    ...f.policy,
    body: f.body(),
    signal: new AbortController().signal,
  });
  expect(output.status).toBe('refused');
  if (output.status !== 'refused')
    throw Error('Unexpected accepted malformed evidence');
  if (reason) expect(output.reason).toBe(reason);
  expect(output.signingAllowed).toBe(false);
  expect(output.providerQualified).toBe(false);
  expect(output.rawResponse?.rawSha256).toBe(digest(raw));
  return output;
}

for (const field of ['fee', 'unitsConsumed', 'loadedAccountsDataSize'])
  for (const [caseIndex, value] of [
    '5000',
    rawNumberToken('5000.0'),
    rawNumberToken('5e3'),
    -1n,
  ].entries())
    it(`refuses non-integer wire type or negative ${field}: case ${caseIndex}`, () =>
      refusal((f) => {
        first(f)[field] = value;
      }, 'wire integer type or range differs'));
it('refuses a quoted slot', () =>
  refusal((f) => {
    record(f.envelope.result.context).slot = '101';
  }, 'wire integer type or range differs'));
for (const slot of [100n, 102n])
  it(`does not adopt a different returned bank ${slot}`, () =>
    refusal((f) => {
      f.envelope.result.context.slot = slot;
    }, 'returned bank differs'));
it('does not coerce a numeric RPC id into the expected string', () =>
  refusal((f) => {
    record(f.envelope).id = 1n;
  }, 'RPC envelope or exact string id differs'));
it('refuses result plus error rather than preferring a successful branch', () =>
  refusal((f) => {
    record(f.envelope).error = {
      code: -32602n,
      message: 'private-like provider text',
    };
  }, 'RPC envelope or exact string id differs'));
it('retains a valid RPC refusal privately without putting provider text in its safe reason', async () => {
  const f = await jitoRawResponseFixture();
  const error = {
    jsonrpc: '2.0',
    id: 'jito-test',
    error: { code: -32602n, message: 'FAKE_PRIVATE_URL_OR_KEY' },
  };
  const output = await read({
    ...f.policy,
    body: f.body(error),
    signal: new AbortController().signal,
  });
  expect(output.status).toBe('refused');
  if (output.status !== 'refused') throw Error('Unexpected success');
  expect(output.reason).toBe('provider RPC refusal');
  expect(output.reason).not.toContain('FAKE_PRIVATE');
  expect(output.rawResponse?.rawSha256).toBe(digest(f.wire(error)));
});
for (const branch of ['envelope', 'context', 'value', 'frame', 'account'])
  it(`refuses unknown ${branch} fields before projection`, () =>
    refusal((f) => {
      const v =
        branch === 'envelope'
          ? record(f.envelope)
          : branch === 'context'
            ? record(f.envelope.result.context)
            : branch === 'value'
              ? record(f.envelope.result.value)
              : branch === 'frame'
                ? first(f)
                : rawAccount(f);
      v.unreviewedExtension = true;
    }, 'unknown or missing field'));
for (const field of [
  'fee',
  'loadedAccountsDataSize',
  'loadedAddresses',
  'unitsConsumed',
])
  it(`never manufactures absent ${field}`, () =>
    refusal((f) => {
      delete first(f)[field];
    }, 'unknown or missing field'));
for (const field of ['lamports', 'rentEpoch', 'space'])
  it(`does not accept a quoted numeric account ${field}`, () =>
    refusal((f) => {
      rawAccount(f)[field] = '0';
    }, 'wire integer type or range differs'));
it('refuses numeric account ownership', () =>
  refusal((f) => {
    rawAccount(f).owner = 1111n;
  }, 'address string required'));
it('refuses numeric base64 account data', () =>
  refusal((f) => {
    rawAccount(f).data = [1234n, 'base64'];
  }, 'canonical base64 required'));
it('checks space against actual decoded bytes', () =>
  refusal((f) => {
    rawAccount(f).space = 1n;
  }, 'raw account space differs'));
it('accepts optional null space and null/omitted ancillary vectors without inventing their content', async () => {
  const f = await jitoRawResponseFixture();
  for (const frame of f.envelope.result.value.transactionResults) {
    for (const a of [
      ...frame.preExecutionAccounts,
      ...frame.postExecutionAccounts,
    ])
      if (a) record(a).space = null;
    record(frame).preBalances = null;
    delete record(frame).postBalances;
    record(frame).preTokenBalances = null;
    delete record(frame).postTokenBalances;
    record(frame).logs = null;
    record(frame).returnData = null;
  }
  const output = await read({
    ...f.policy,
    body: f.body(),
    signal: new AbortController().signal,
  });
  expect(output.status).toBe('admitted');
});
it('refuses balances contradicting the raw vector', () =>
  refusal((f) => {
    (first(f).preBalances as bigint[])[0]++;
  }, 'balance metadata contradicts raw account'));
it('refuses incomplete balance arrays', () =>
  refusal((f) => {
    (first(f).postBalances as bigint[]).pop();
  }, 'balance metadata vector differs'));
it('refuses an incomplete account vector', () =>
  refusal((f) => {
    (first(f).postExecutionAccounts as unknown[]).pop();
  }, 'full raw account vector required'));
it('refuses a changed loaded-address vector via the unchanged frame verifier', () =>
  refusal((f) => {
    record(first(f).loadedAddresses).writable = [];
  }, 'normalized frame checks refused'));
it('refuses a changed frame fee instead of deriving it from observed conservation', () =>
  refusal((f) => {
    first(f).fee = 4999n;
  }, 'normalized frame checks refused'));
it('refuses a nonnull replacement blockhash', () =>
  refusal((f) => {
    first(f).replacementBlockhash = { blockhash: 'replacement' };
  }, 'failed or replaced raw frame'));
it('refuses partial raw success', () =>
  refusal((f) => {
    f.envelope.result.value.transactionResults.pop();
  }, 'failed or partial raw result'));
it('refuses an echoed different transaction', () =>
  refusal((f) => {
    first(f).transaction = f.fixture.packets[1].transaction;
  }, 'transaction echo differs'));
it('bounds log metadata before discarding it', () =>
  refusal((f) => {
    first(f).logs = ['x'.repeat(16385)];
  }, 'log metadata exceeds profile'));
it('bounds return data before discarding it', () =>
  refusal((f) => {
    first(f).returnData = {
      programId: f.fixture.walletRoster[0],
      data: [Buffer.alloc(1025).toString('base64'), 'base64'],
    };
  }, 'base64 data exceeds profile'));

function tokenRow(f: F) {
  const rows = first(f).preTokenBalances as Record<string, unknown>[];
  if (!rows.length) throw Error('Expected synthetic pool token metadata');
  return rows[0];
}
it('cross-checks token raw amount strings before discarding UI metadata', () =>
  refusal((f) => {
    record(tokenRow(f).uiTokenAmount).amount = '1';
  }, 'token metadata amount differs'));
it('does not turn numeric token raw amounts into canonical strings', () =>
  refusal((f) => {
    record(tokenRow(f).uiTokenAmount).amount = 1n;
  }, 'token metadata amount differs'));
it('rejects duplicate token indices', () =>
  refusal((f) => {
    const a = first(f).preTokenBalances as unknown[];
    a.push(a[0]);
  }, 'token metadata index differs'));
it('checks metadata owner against raw account bytes', () =>
  refusal((f) => {
    tokenRow(f).owner = f.fixture.walletRoster[0];
  }, 'token metadata owner differs'));
it('checks metadata program against actual raw account owner', () =>
  refusal((f) => {
    tokenRow(f).programId = f.fixture.walletRoster[0];
  }, 'token metadata program differs'));
it('rejects string UI amount numbers instead of coercing them', () =>
  refusal((f) => {
    record(tokenRow(f).uiTokenAmount).uiAmount = '1.0';
  }, 'token display number type differs'));
it('refuses nonfinite display metadata while leaving exact units separate', () =>
  refusal((f) => {
    record(tokenRow(f).uiTokenAmount).uiAmount = rawNumberToken('1e999');
  }, 'token display number exceeds profile'));
it('accepts different finite display rounding only as discarded metadata, not as economic output', async () => {
  const f = await jitoRawResponseFixture();
  const row = tokenRow(f);
  record(row.uiTokenAmount).uiAmount = rawNumberToken('0.0000000001');
  record(row.uiTokenAmount).uiAmountString = '0.0000000001';
  const output = await read({
    ...f.policy,
    body: f.body(),
    signal: new AbortController().signal,
  });
  expect(output.status).toBe('admitted');
  if (output.status !== 'admitted') throw Error(output.reason);
  const replay = await verifyJitoBundleEconomicObservation({
    ...f.fixture,
    result: output.normalizedResult,
  });
  expect(replay.outcomes[0].observedOutputRaw).toBe('1000');
  expect(replay.signingAllowed).toBe(false);
});
it('keeps raw malformed-body failures distinct and exposes no fabricated partial digest', async () => {
  const f = await jitoRawResponseFixture();
  const output = await read({
    ...f.policy,
    body: new Response('{bad').body,
    signal: new AbortController().signal,
  });
  expect(output.status).toBe('refused');
  if (output.status !== 'refused') throw Error('Unexpected success');
  expect(output.reason).toBe('raw response unavailable');
  expect(output.rawResponse).toBeNull();
});
it('captures packet bindings before an asynchronous input change', async () => {
  const f = await jitoRawResponseFixture({ wallets: 2, lookup: true });
  const before = f.fixture.packets.map((p) => p.transaction);
  const input = {
    ...f.policy,
    body: f.body(),
    signal: new AbortController().signal,
  };
  const pending = read(input);
  f.policy.packets.reverse();
  input.rpcId = 'changed';
  input.simulationBankSlot = 102;
  const output = await pending;
  expect(output.status).toBe('admitted');
  if (output.status !== 'admitted') throw Error(output.reason);
  expect(output.frames.frames.map((f) => f.transaction)).toEqual(before);
  expect(output.request.rpcId).toBe('jito-test');
});

for (const field of ['lamports', 'rentEpoch', 'space'])
  it(`never admits an opaque decimal at account integer ${field}`, () =>
    refusal((f) => {
      rawAccount(f)[field] = rawNumberToken('1.0');
    }, 'wire integer type or range differs'));
for (const field of ['accountIndex', 'decimals'])
  it(`never admits a decimal at token metadata integer ${field}`, () =>
    refusal((f) => {
      if (field === 'accountIndex') tokenRow(f)[field] = rawNumberToken('1.0');
      else record(tokenRow(f).uiTokenAmount)[field] = rawNumberToken('1.0');
    }, 'wire integer type or range differs'));
for (const field of ['result', 'loadedAddresses', 'returnData'])
  it(`rejects decimal tokens in an object position ${field}`, () =>
    refusal((f) => {
      if (field === 'result') record(f.envelope).result = rawNumberToken('1.0');
      else first(f)[field] = rawNumberToken('1.0');
    }, 'object required'));
it('rejects a decimal at the slot position', () =>
  refusal((f) => {
    record(f.envelope.result.context).slot = rawNumberToken('101.0');
  }, 'wire integer type or range differs'));
it('rejects inconsistent token precision metadata without claiming mint precision admission', () =>
  refusal((f) => {
    const row = tokenRow(f),
      mint = row.mint;
    const post = (first(f).postTokenBalances as Record<string, unknown>[]).find(
      (r) => r.mint === mint,
    )!;
    record(post.uiTokenAmount).decimals = 4n;
  }, 'token metadata precision is inconsistent'));
it('returns a generic schema refusal for a decimal RPC error object', async () => {
  const f = await jitoRawResponseFixture();
  const output = await read({
    ...f.policy,
    body: f.body({
      jsonrpc: '2.0',
      id: 'jito-test',
      error: rawNumberToken('1.0'),
    }),
    signal: new AbortController().signal,
  });
  expect(output.status).toBe('refused');
  if (output.status !== 'refused') throw Error('Unexpected admission');
  expect(output.reason).toBe('object required');
});
it('documents early refusal ownership by leaving the unconsumed stream with its caller', async () => {
  const f = await jitoRawResponseFixture(),
    cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
  await expect(
    read({
      ...f.policy,
      minimumSlot: 102,
      body,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('request profile or bank bounds differ');
  expect(body.locked).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
  await body.cancel();
});
it('cancels an acquired pending body read without exposing the abort reason or partial hash', async () => {
  const f = await jitoRawResponseFixture(),
    controller = new AbortController(),
    cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        controller.abort('FAKE_PRIVATE_ABORT_REASON');
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const output = await read({ ...f.policy, body, signal: controller.signal });
  expect(output.status).toBe('refused');
  if (output.status !== 'refused') throw Error('Unexpected admission');
  expect(output.reason).toBe('raw response unavailable');
  expect(output.reason).not.toContain('FAKE_PRIVATE');
  expect(output.rawResponse).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});
it('refuses publication when cancellation arrives during the final frame hash recheck', async () => {
  const f = await jitoRawResponseFixture(),
    controller = new AbortController();
  const raw = new TextEncoder().encode(f.wire());
  const actual = crypto.subtle.digest.bind(crypto.subtle);
  let captured = false;
  const spy = vi
    .spyOn(crypto.subtle, 'digest')
    .mockImplementation(async (algorithm, data) => {
      const result = await actual(algorithm, data);
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      if (bytes.length === raw.length && bytes.every((b, i) => b === raw[i]))
        captured = true;
      else if (captured) controller.abort('FAKE_LATE_REASON');
      return result;
    });
  try {
    const output = await read({
      ...f.policy,
      body: f.body(),
      signal: controller.signal,
    });
    expect(captured).toBe(true);
    expect(output.status).toBe('refused');
    if (output.status !== 'refused') throw Error('Unexpected admission');
    expect(output.reason).toBe('request interrupted');
    expect(output.rawResponse).not.toBeNull();
    expect(output.executionAllowed).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
