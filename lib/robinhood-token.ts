// Fixed, read-only official public RPC. No credentials or transaction methods.
export const ROBINHOOD_READ_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export type RobinhoodToken = { address: string; chainId: 4663; block: string; name: string; symbol: string; decimals: number; totalSupplyRaw: string; source: string };

function uint(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Unsupported token metadata encoding.');
  return BigInt(value);
}
function text(value: string) {
  if (!/^0x[0-9a-fA-F]+$/.test(value) || value.length > 2050 || value.length < 130) throw new Error('Unsupported token metadata encoding.');
  const hex = value.slice(2);
  if (BigInt('0x' + hex.slice(0, 64)) !== 32n) throw new Error('Unsupported token metadata encoding.');
  const length = Number(BigInt('0x' + hex.slice(64, 128)));
  if (length < 1 || length > 256 || hex.length < 128 + length * 2) throw new Error('Unsupported token metadata encoding.');
  const bytes = Uint8Array.from(hex.slice(128, 128 + length * 2).match(/../g)!, (pair) => parseInt(pair, 16));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('').filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('');
}
export async function inspectRobinhoodToken(address: string, fetcher: typeof fetch = fetch): Promise<RobinhoodToken> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Enter 0x followed by 40 hexadecimal characters.');
  const signal = AbortSignal.timeout(12_000);
  async function rpc(method: 'eth_chainId' | 'eth_blockNumber' | 'eth_getCode' | 'eth_call', params: unknown[] = []) {
    const response = await fetcher(ROBINHOOD_READ_RPC, { method: 'POST', redirect: 'manual', cache: 'no-store', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!response.ok) throw new Error('Public RPC unavailable or rate-limited. Try again later.');
    // Bound response bytes before buffering a provider response.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty RPC response.');
    let raw = ''; let size = 0; const decoder = new TextDecoder();
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 262144) { await reader.cancel(); throw new Error('RPC response exceeds the inspection limit.'); } raw += decoder.decode(value, { stream: true }); }
    } finally { reader.releaseLock(); }
    const result = JSON.parse(raw + decoder.decode()) as { result?: unknown; error?: unknown };
    if (result.error || typeof result.result !== 'string') throw new Error('Token metadata unavailable from public RPC.');
    return result.result;
  }
  if (await rpc('eth_chainId') !== '0x1237') throw new Error('RPC network mismatch. Inspection stopped.');
  const block = await rpc('eth_blockNumber');
  if (!/^0x[0-9a-fA-F]{1,16}$/.test(block)) throw new Error('Invalid RPC block.');
  const code = await rpc('eth_getCode', [address, block]);
  if (!/^0x[0-9a-fA-F]+$/.test(code) || code === '0x0') throw new Error('No contract found at this address.');
  const values = await Promise.all(['0x06fdde03', '0x95d89b41', '0x313ce567', '0x18160ddd'].map(data => rpc('eth_call', [{ to: address, data }, block])));
  const decimals = Number(uint(values[2]));
  if (decimals > 255) throw new Error('Unsupported token decimals.');
  return { address, chainId: 4663, block, name: text(values[0]), symbol: text(values[1]), decimals, totalSupplyRaw: uint(values[3]).toString(), source: ROBINHOOD_READ_RPC };
}

export function formatTokenSupply(raw: string, decimals: number) {
 const padded = raw.padStart(decimals + 1, '0');
 const whole = (decimals ? padded.slice(0, -decimals) : padded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
 const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, '') : '';
 return whole + (fraction ? '.' + fraction : '');
}
