import { writeFile } from 'node:fs/promises';
import {
  PUMP_GROUP_JITO_ENDPOINT,
  PUMP_GROUP_JITO_TIP_ACCOUNTS,
} from '../lib/pump-group-broadcast';
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  operation: 'getTipAccounts-only',
  endpoint: PUMP_GROUP_JITO_ENDPOINT,
  broadcasts: 0,
  signatures: 0,
  userWallets: 0,
  deliveryVerified: false,
  v1SendVerified: false,
};
try {
  const response = await fetch(PUMP_GROUP_JITO_ENDPOINT, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTipAccounts',
      params: [],
    }),
  });
  if (!response.ok) throw new Error('Read-only Jito request unavailable.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response.');
  let size = 0,
    text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 16384) throw new Error('Response bound.');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = JSON.parse(text) as {
    jsonrpc?: string;
    id?: number;
    error?: unknown;
    result?: unknown;
  };
  if (
    body.jsonrpc !== '2.0' ||
    body.id !== 1 ||
    body.error ||
    !Array.isArray(body.result) ||
    body.result.length !== 8 ||
    new Set(body.result).size !== 8 ||
    body.result.some(
      (v) =>
        typeof v !== 'string' ||
        !(PUMP_GROUP_JITO_TIP_ACCOUNTS as readonly string[]).includes(v),
    )
  )
    throw new Error('Reviewed tip profile differs.');
  Object.assign(report, {
    classification: 'current-tip-profile-matches',
    tipAccounts: body.result,
  });
} catch {
  Object.assign(report, {
    classification: 'inconclusive',
    blocker:
      'The read-only endpoint or current reviewed tip profile could not be verified.',
  });
}
await writeFile(
  'docs/CODEX-GROUP-JITO-READINESS-20261015.json',
  JSON.stringify(report, null, 2) + '\n',
);
process.stdout.write(
  JSON.stringify({
    classification: report.classification,
    broadcasts: 0,
    signatures: 0,
  }) + '\n',
);
