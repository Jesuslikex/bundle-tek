import { expect, it, vi } from 'vitest';
import { formatTokenSupply, inspectRobinhoodToken } from './robinhood-token';
it('rejects malformed addresses before any network request', async () => {
 const fetcher = vi.fn();
 await expect(inspectRobinhoodToken('https://attacker.test', fetcher)).rejects.toThrow('40 hexadecimal');
 expect(fetcher).not.toHaveBeenCalled();
});

const word = (n: number) => n.toString(16).padStart(64, '0');
const abiString = (s: string) => '0x' + word(32) + word(s.length) + Buffer.from(s).toString('hex').padEnd(64, '0');
const address = '0xa114f757fae463fb737ef88bbafc6c3f502c430d';
it('reads metadata at one block on the fixed official chain without transaction methods', async () => {
 const calls: Array<{method: string; params: unknown[]}> = [];
 const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
  expect(url).toBe('https://rpc.mainnet.chain.robinhood.com');
  expect(options?.redirect).toBe('manual');
  const body = JSON.parse(typeof options?.body === 'string' ? options.body : ''); calls.push(body);
  const results: Record<string, string> = { eth_chainId: '0x1237', eth_blockNumber: '0xabc', eth_getCode: '0x6000' };
  const metadata: Record<string, string> = { '0x06fdde03': abiString('Sigmahood/HIMS'), '0x95d89b41': abiString('SIGMA'), '0x313ce567': '0x' + word(18), '0x18160ddd': '0x' + word(1000) };
  return Response.json({ jsonrpc: '2.0', id: 1, result: body.method === 'eth_call' ? metadata[body.params[0].data] : results[body.method] });
 }) as typeof fetch;
 expect(await inspectRobinhoodToken(address, fetcher)).toMatchObject({ address, chainId: 4663, block: '0xabc', name: 'Sigmahood/HIMS', symbol: 'SIGMA', decimals: 18, totalSupplyRaw: '1000' });
 expect(calls.filter(c => c.method === 'eth_call').every(c => c.params[1] === '0xabc')).toBe(true);
 expect(calls.every(c => ['eth_chainId','eth_blockNumber','eth_getCode','eth_call'].includes(c.method))).toBe(true);
});

it.each([
 ['wrong network', 'eth_chainId', '0x1', 'network mismatch'],
 ['no contract', 'eth_getCode', '0x', 'No contract'],
 ['malformed ABI', 'eth_call', '0x1234', 'encoding'],
])('rejects %s rather than inventing metadata', async (_label, badMethod, badValue, error) => {
 const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
 const b = JSON.parse(typeof options?.body === 'string' ? options.body : '');
 const good: Record<string,string> = { eth_chainId: '0x1237', eth_blockNumber: '0xabc', eth_getCode: '0x6000', eth_call: '0x' + word(1) };
 return Response.json({ result: b.method === badMethod ? badValue : good[b.method] });
 }) as typeof fetch;
 await expect(inspectRobinhoodToken(address, fetcher)).rejects.toThrow(error);
});

it('formats large raw supply without losing precision', () => {
 expect(formatTokenSupply('1000000000000000000000000000', 18)).toBe('1,000,000,000');
 expect(formatTokenSupply('123456789012345678901', 6)).toBe('123,456,789,012,345.678901');
 expect(formatTokenSupply('1', 18)).toBe('0.000000000000000001');
});
