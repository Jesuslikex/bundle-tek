import { balanceRpc } from './wallet-balances';
import { EVM_NETWORKS } from './evm-network';
import { validateTokenSource } from './token-source';

function quantity(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,13})$/.test(value) ||
    BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error('Invalid token block quantity.');
  return Number(BigInt(value));
}
function uint(value: unknown) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error('Incomplete token integer response.');
  return BigInt(value);
}
export function decodeEvmIdentityText(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value) ||
    value.length > 642
  )
    throw new Error('Unsupported token text encoding.');
  let hex = value.slice(2);
  if (hex.length === 64) {
    // Older contracts expose padded bytes32 name/symbol values.
    const zero = hex.match(/00/); // Trim only the zero-terminated suffix at byte boundaries below.
    if (zero) {
      for (let i = 0; i < hex.length; i += 2) {
        if (hex.slice(i, i + 2) === '00') {
          if (!/^0*$/.test(hex.slice(i)))
            throw new Error('Invalid bytes32 text padding.');
          hex = hex.slice(0, i);
          break;
        }
      }
    }
  } else {
    if (hex.length < 128 || BigInt('0x' + hex.slice(0, 64)) !== 32n)
      throw new Error('Invalid token string offset.');
    const size = BigInt('0x' + hex.slice(64, 128));
    if (size < 1n || size > 256n)
      throw new Error('Token text exceeds the inspection limit.');
    const length = Number(size);
    const end = 128 + length * 2;
    if (
      hex.length !== 128 + Math.ceil(length / 32) * 64 ||
      !/^0*$/.test(hex.slice(end))
    )
      throw new Error('Invalid token string padding.');
    hex = hex.slice(128, end);
  }
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (pair) =>
    parseInt(pair, 16),
  );
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const text = decoded.trim();
  if (
    !text ||
    Array.from(decoded).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    throw new Error('Invalid token identity text.');
  return text;
}
async function inspectIdentity(
  input: unknown,
  fetcher: typeof fetch = fetch,
  anchor?: { blockNumber: number; blockHash: string; signal: AbortSignal },
) {
  const token = validateTokenSource(input);
  if (token.chain === 'Solana') throw new Error('Choose an EVM contract.');
  const network = EVM_NETWORKS[token.chain];
  const signal = AbortSignal.any([
    AbortSignal.timeout(12000),
    ...(anchor ? [anchor.signal] : []),
  ]);
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(network.endpoint, method, params, signal, fetcher);
  if (quantity(await rpc('eth_chainId', [])) !== network.id)
    throw new Error('Token provider network mismatch.');
  const header = (await rpc('eth_getBlockByNumber', [
    anchor ? '0x' + anchor.blockNumber.toString(16) : 'latest',
    false,
  ])) as {
    number?: unknown;
    hash?: unknown;
    timestamp?: unknown;
  };
  const blockNumber = quantity(header?.number);
  const timestamp = quantity(header?.timestamp) * 1000;
  if (
    typeof header?.hash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(header.hash)
  )
    throw new Error('Invalid token block hash.');
  if (
    timestamp < (anchor ? 1577836800000 : Date.now() - 900000) ||
    timestamp > Date.now() + 300000
  )
    throw new Error('Token provider block is stale.');
  const blockHash = header.hash;
  if (
    anchor &&
    (blockNumber !== anchor.blockNumber ||
      blockHash.toLowerCase() !== anchor.blockHash.toLowerCase())
  )
    throw new Error(
      'Historical token block does not match the saved transaction.',
    );
  const reference = { blockHash, requireCanonical: true };
  const code = await rpc('eth_getCode', [token.address, reference]);
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
    throw new Error('No token contract at this address.');
  const values = await Promise.all(
    ['0x06fdde03', '0x95d89b41', '0x313ce567', '0x18160ddd'].map((data) =>
      rpc('eth_call', [{ to: token.address, data, gas: '0x186a0' }, reference]),
    ),
  );
  const name = decodeEvmIdentityText(values[0]),
    symbol = decodeEvmIdentityText(values[1]);
  const decimals = uint(values[2]);
  if (decimals > 255n) throw new Error('Unsupported token decimals.');
  const totalSupplyRaw = uint(values[3]).toString();
  const final = (await rpc('eth_getBlockByNumber', [
    '0x' + blockNumber.toString(16),
    false,
  ])) as { hash?: unknown; number?: unknown; timestamp?: unknown };
  if (
    final?.hash !== blockHash ||
    (anchor &&
      (final.number !== header.number || final.timestamp !== header.timestamp))
  )
    throw new Error('Token block changed during lookup.');
  return {
    ...token,
    name,
    symbol,
    decimals: Number(decimals),
    totalSupplyRaw,
    blockNumber,
    blockHash,
    observedAt: new Date().toISOString(),
    source: new URL(network.endpoint).hostname,
  };
}
export function inspectEvmTokenIdentity(
  input: unknown,
  fetcher: typeof fetch = fetch,
) {
  return inspectIdentity(input, fetcher);
}
export function inspectEvmTokenIdentityAtBlock(
  input: unknown,
  anchor: {
    blockNumber: string;
    blockHash: string;
  },
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  if (
    !/^(0|[1-9]\d{0,15})$/.test(anchor.blockNumber) ||
    !Number.isSafeInteger(Number(anchor.blockNumber)) ||
    !/^0x[0-9a-fA-F]{64}$/.test(anchor.blockHash)
  )
    throw new Error('Invalid historical token block.');
  return inspectIdentity(input, fetcher, {
    blockNumber: Number(anchor.blockNumber),
    blockHash: anchor.blockHash,
    signal,
  });
}
