import { createHash, createPublicKey, verify } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import bs58 from 'bs58';
const SIGNATURE =
  '3qcuiJd614zpxRq4935DZwdgcrpR32k8N7Xh5H32EB4w2QXonLQWc4XBrL6oMEfoegnCYKXGddQD95YC86rarEh8';
const fail = () => {
  throw Error('Upgrade signature verification refused.');
};

/** Checks signatures over exact message bytes. This does not authenticate the
 * RPC's slot, execution status, inner instructions, source code or chain fork. */
export function verifyUpgradeMessageSignatures(
  messageBytes,
  signatures,
  signerAddresses,
  expectedSignature,
) {
  if (
    !(messageBytes instanceof Uint8Array) ||
    messageBytes.length < 1 ||
    messageBytes.length > 1232 ||
    !Array.isArray(signerAddresses) ||
    signerAddresses.length < 1 ||
    signerAddresses.length > 32 ||
    !signatures ||
    typeof signatures !== 'object' ||
    Array.isArray(signatures) ||
    Object.keys(signatures).length !== signerAddresses.length
  )
    return fail();
  const seen = new Set();
  for (const address of signerAddresses) {
    if (typeof address !== 'string' || seen.has(address)) return fail();
    seen.add(address);
    const key = Buffer.from(bs58.decode(address));
    const sig = signatures[address];
    if (
      key.length !== 32 ||
      bs58.encode(key) !== address ||
      !(sig instanceof Uint8Array) ||
      sig.length !== 64
    )
      return fail();
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      key,
    ]);
    if (
      !verify(
        null,
        messageBytes,
        createPublicKey({ key: spki, format: 'der', type: 'spki' }),
        sig,
      )
    )
      return fail();
  }
  if (
    typeof expectedSignature !== 'string' ||
    bs58.encode(signatures[signerAddresses[0]]) !== expectedSignature
  )
    return fail();
  return {
    signerCount: signerAddresses.length,
    messageSha256: createHash('sha256').update(messageBytes).digest('hex'),
    signaturesVerified: true,
    chainInclusionVerified: false,
    sourceVerified: false,
    signingAllowed: false,
    executionAllowed: false,
  };
}

export function inspectSerializedUpgrade(response) {
  if (
    !response ||
    response.slot !== 459479624 ||
    !response.meta ||
    response.meta.err !== null ||
    !Array.isArray(response.transaction) ||
    response.transaction.length !== 2 ||
    response.transaction[1] !== 'base64' ||
    typeof response.transaction[0] !== 'string' ||
    response.transaction[0].length > 1644
  )
    return fail();
  const wire = Buffer.from(response.transaction[0], 'base64');
  if (wire.length > 1232 || wire.toString('base64') !== response.transaction[0])
    return fail();
  const tx = getTransactionDecoder().decode(wire),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const count = message.header.numSignerAccounts;
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > message.staticAccounts.length
  )
    return fail();
  return {
    providerReportedSlot: response.slot,
    wireSha256: createHash('sha256').update(wire).digest('hex'),
    ...verifyUpgradeMessageSignatures(
      tx.messageBytes,
      tx.signatures,
      message.staticAccounts.slice(0, count),
      SIGNATURE,
    ),
  };
}

async function probe() {
  const endpoint = 'https://api.mainnet-beta.solana.com';
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'upgrade-signature',
      method: 'getTransaction',
      params: [
        SIGNATURE,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  });
  if (!response.ok || !response.body) return fail();
  const reader = response.body.getReader(),
    chunks = [];
  let n = 0,
    done = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        done = true;
        break;
      }
      n += part.value.length;
      if (n > 1_048_576) return fail();
      chunks.push(part.value);
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const envelope = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
  );
  if (
    envelope?.jsonrpc !== '2.0' ||
    envelope.id !== 'upgrade-signature' ||
    !Object.hasOwn(envelope, 'result') ||
    Object.hasOwn(envelope, 'error')
  )
    return fail();
  return {
    format: 'jupiter-upgrade-signature-observation-v1',
    observedAt: new Date().toISOString(),
    ...inspectSerializedUpgrade(envelope.result),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await probe(), null, 2));
  } catch {
    console.error('Upgrade signature observation unavailable or refused.');
    process.exitCode = 1;
  }
}
