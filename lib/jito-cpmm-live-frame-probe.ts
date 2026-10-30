import bs58 from 'bs58';
import { createJitoQualificationTransport } from './jito-qualification-transport';
import { snapshotJitoEvidence } from './jito-evidence-json';
const flags = {
  diagnosticOnly: true as const,
  bankVerified: false as const,
  feeBankVerified: false as const,
  fullSwapQualified: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
};
/** One exact-slot capability query only. Returned vectors are not financial,
 * provenance or complete-frame verification; raw replies remain inspectable. */
export async function probeJitoCpmmLiveFrames(
  input: {
    transactions: string[];
    addresses: string[];
    minimumSlot: number;
    simulationSlot: number;
  },
  signal: AbortSignal,
) {
  let transport: ReturnType<typeof createJitoQualificationTransport> | null =
      null,
    result: unknown = null;
  let status = 'refused';
  const observations: Record<string, unknown> = { ...flags };
  try {
    input = snapshotJitoEvidence(input, 16384);
    observations.requestedBankSlot = input.simulationSlot;
    if (
      !Number.isSafeInteger(input.minimumSlot) ||
      input.minimumSlot < 1 ||
      !Number.isSafeInteger(input.simulationSlot) ||
      input.simulationSlot < input.minimumSlot ||
      input.simulationSlot - input.minimumSlot > 32 ||
      !Array.isArray(input.transactions) ||
      input.transactions.length < 1 ||
      input.transactions.length > 5 ||
      !Array.isArray(input.addresses) ||
      input.addresses.length < 1 ||
      input.addresses.length > 32 ||
      new Set(input.addresses).size !== input.addresses.length
    )
      throw Error('Scope refused');
    for (const key of input.addresses) {
      const b = bs58.decode(key);
      if (b.length !== 32 || bs58.encode(b) !== key)
        throw Error('Address refused');
    }
    const transactions = input.transactions.map((encoded) => {
      if (typeof encoded !== 'string' || encoded.length > 1644)
        throw Error('Packet refused');
      const b = Buffer.from(encoded, 'base64');
      if (
        b.toString('base64') !== encoded ||
        b.length < 66 ||
        b.length > 1232 ||
        b[0] !== 1 ||
        !b.subarray(1, 65).every((x: number) => x === 0)
      )
        throw Error('Unsigned packet refused');
      return encoded;
    });
    const addresses = [...input.addresses],
      count = transactions.length,
      slot = input.simulationSlot;
    transport = createJitoQualificationTransport(
      'bundle',
      input.minimumSlot,
      signal,
    );
    result = await transport.rpc(
      'simulateBundle',
      [
        { encodedTransactions: transactions },
        {
          transactionEncoding: 'base64',
          simulationBank: { slot },
          skipSigVerify: true,
          replaceRecentBlockhash: false,
          preExecutionAccountsConfigs: transactions.map(() => ({
            addresses: [...addresses],
            encoding: 'base64',
          })),
          postExecutionAccountsConfigs: transactions.map(() => ({
            addresses: [...addresses],
            encoding: 'base64',
          })),
        },
      ],
      signal,
    );
    const reply = result as {
      context?: { slot?: unknown };
      value?: { summary?: unknown; transactionResults?: unknown[] };
    };
    observations.returnedBankSlot = reply.context?.slot;
    if (
      reply.context?.slot !== String(slot) ||
      !Array.isArray(reply.value?.transactionResults) ||
      reply.value.transactionResults.length !== count
    )
      throw Error('Exact bank or vector refused');
    const rows = reply.value.transactionResults as Record<string, unknown>[];
    observations.bundleSummary =
      reply.value.summary === 'succeeded' ? 'succeeded' : 'not-succeeded';
    observations.frames = rows.map((row) => ({
      preCount: Array.isArray(row.preExecutionAccounts)
        ? row.preExecutionAccounts.length
        : null,
      postCount: Array.isArray(row.postExecutionAccounts)
        ? row.postExecutionAccounts.length
        : null,
      feePresent: typeof row.fee === 'string',
      replacementBlockhashPresent: Object.hasOwn(row, 'replacementBlockhash'),
      error: row.err === null ? null : 'simulation-error',
    }));
    if (
      reply.value.summary !== 'succeeded' ||
      rows.some(
        (row) =>
          row.err !== null ||
          !Array.isArray(row.preExecutionAccounts) ||
          row.preExecutionAccounts.length !== addresses.length ||
          !Array.isArray(row.postExecutionAccounts) ||
          row.postExecutionAccounts.length !== addresses.length,
      )
    )
      throw Error('Incomplete images');
    status = 'complete-requested-vectors-observed';
  } catch {
    const last = transport?.captures().at(-1);
    if (last?.captureStatus === 'captured')
      try {
        const raw = JSON.parse(Buffer.from(last.rawBody).toString('utf8')) as {
          error?: { code?: unknown; message?: unknown };
        };
        observations.refusal =
          raw.error?.code === -32602 &&
          raw.error.message ===
            `bank not found for the provided slot: ${input.simulationSlot}`
            ? 'bank-unavailable'
            : 'simulation-or-shape-refused';
      } catch {
        observations.refusal = 'simulation-or-shape-refused';
      }
  }
  transport?.close();
  return {
    summary: {
      status,
      observations,
      transport: transport?.summary() ?? null,
      ...flags,
    },
    result,
    captures:
      transport?.captures().map(({ rawBody, ...c }) => ({
        ...c,
        rawBodyBase64: Buffer.from(rawBody).toString('base64'),
      })) ?? [],
  };
}
