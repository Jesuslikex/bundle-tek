import { writeFile } from 'node:fs/promises';
import { parseBalanceJson } from '../lib/wallet-balances';
import { collectPumpProgramIdentities } from '../lib/pump-group-code-identity';
import {
  PUMP_LAUNCH_PROGRAM,
  PUMP_TOKEN_2022,
  PUMP_TOKEN,
} from '../lib/pump-launch-config';
import { probePumpGroupReplay } from '../lib/pump-group-runtime-probe';
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  operation: process.argv.includes('--code-identities')
    ? 'listed-protocol-program-code-identities'
    : 'unsigned-nonempty-v1-replay-profile',
  classification: 'inconclusive',
  userWallets: 0,
  broadcasts: 0,
  signingAllowed: false,
  executionAllowed: false,
};
try {
  const endpoint = new URL(
    process.env.SOLANA_INDEXER_RPC_URL ||
      process.env.SOLANA_MAINNET_RPC_URL ||
      '',
  );
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    ![
      'mainnet.helius-rpc.com',
      'solana-mainnet.g.alchemy.com',
      'api.mainnet-beta.solana.com',
    ].includes(endpoint.hostname)
  )
    throw new Error('Configured provider unavailable.');
  let id = 0;
  async function rpcAt(
    url: URL,
    method: string,
    params: unknown[],
    signal: AbortSignal,
  ) {
    if (
      ![
        'getClusterNodes',
        'getMultipleAccounts',
        'getGenesisHash',
        'getLatestBlockhash',
        'getAccountInfo',
        'simulateBundle',
      ].includes(method)
    )
      throw new Error('No mutation transport.');
    const key = ++id;
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: key, method, params }),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response unavailable.');
    const decoder = new TextDecoder();
    let text = '',
      size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2097152) throw new Error('Response bound.');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const body = parseBalanceJson(text) as {
      jsonrpc?: string;
      id?: string;
      result?: unknown;
      error?: { code?: string };
    };
    if (
      !response.ok ||
      body?.jsonrpc !== '2.0' ||
      body?.id !== String(key) ||
      body.error ||
      body.result === undefined
    ) {
      report.rpcErrorCode =
        typeof body?.error?.code === 'string' &&
        /^-?\d{1,6}$/.test(body.error.code)
          ? Number(body.error.code)
          : null;
      throw new Error('Read-only RPC failed.');
    }
    return body.result;
  }
  const signal = AbortSignal.timeout(25000);
  if (process.argv.includes('--code-identities')) {
    const latest = (await rpcAt(
      endpoint,
      'getLatestBlockhash',
      [{ commitment: 'confirmed' }],
      signal,
    )) as { context: { slot: string } };
    const measured = await collectPumpProgramIdentities(
      [
        PUMP_LAUNCH_PROGRAM,
        PUMP_TOKEN_2022,
        PUMP_TOKEN,
        'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e',
        'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        '11111111111111111111111111111111',
      ],
      Number(latest.context.slot),
      signal,
      (method, params, control) => rpcAt(endpoint, method, params, control),
    );
    Object.assign(report, {
      operation: 'listed-protocol-program-code-identities',
      classification: 'identity-measured-policy-unapproved',
      scope:
        'Listed Pump protocol programs only; not an owned group qualification',
      codeIdentities: measured,
      programAttestationRequired: true,
    });
  } else {
    const nodes = await rpcAt(endpoint, 'getClusterNodes', [], signal);
    if (!Array.isArray(nodes))
      throw new Error('Public probe source unavailable.');
    const keys = nodes
      .slice(0, 32)
      .map((node: { pubkey?: unknown }) => node.pubkey)
      .filter((key: unknown): key is string => typeof key === 'string');
    const accounts = (await rpcAt(
      endpoint,
      'getMultipleAccounts',
      [keys, { encoding: 'base64', commitment: 'confirmed' }],
      signal,
    )) as {
      value?: {
        owner: string;
        executable: boolean;
        lamports: string;
        data: string[];
      }[];
    };
    const index =
      accounts.value?.findIndex(
        (account) =>
          account &&
          account.owner === '11111111111111111111111111111111' &&
          !account.executable &&
          account.data?.[0] === '' &&
          typeof account.lamports === 'string' &&
          /^\d+$/.test(account.lamports) &&
          BigInt(account.lamports) >= 20000n,
      ) ?? -1;
    if (index < 0)
      throw new Error(
        'No public validator identity suited the unsigned probe.',
      );
    report.referenceSource = 'public-validator-identity';
    Object.assign(
      report,
      await probePumpGroupReplay(
        keys[index],
        (method, params, control) => rpcAt(endpoint, method, params, control),
        signal,
      ),
    );
  }
} catch (e) {
  report.classification = 'not-qualified';
  report.reason =
    e instanceof Error && !/https?:|api.key|token|secret/i.test(e.message)
      ? e.message
      : 'Read-only probe unavailable.';
}
await writeFile(
  process.argv.includes('--code-identities')
    ? 'docs/CODEX-PUMP-CODE-IDENTITIES-20261015.json'
    : 'docs/CODEX-PUMP-RUNTIME-PROBE-20261015.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report));
