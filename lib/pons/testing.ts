import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { encodeAbiParameters } from 'viem';
export const sample = {
  chainId: 4663,
  mode: 'single-recipient-atomic',
  wallet: '0x4EAb299482FC2a4606626B56601718F2a346C49F',
  recipient: '0x4EAb299482FC2a4606626B56601718F2a346C49F',
  creatorFeeRecipient: '0x4EAb299482FC2a4606626B56601718F2a346C49F',
  name: 'Test',
  symbol: 'TEST',
  logo: '',
  description: '',
  socials: {
    twitter: '',
    telegram: '',
    discord: '',
    website: '',
    farcaster: '',
  },
  creatorTaxBps: 0,
  buybackEnabled: false,
  launchConfigId: '0',
  quoteInWei: '1000000000000',
  maxTotalValueWei: '1000000000000000000',
  maxGasCostWei: '100000000000000000',
  minTokensOut: '1',
  salt: '0x' + '01'.repeat(32),
  snipeTaxExemptions: [],
};
export function sqliteD1() {
  const sql = new DatabaseSync(':memory:');
  const db = {
    prepare(query: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...v: unknown[]) {
          args = v;
          return stmt;
        },
        async run() {
          const r = sql.prepare(query).run(...(args as never[]));
          return { success: true, meta: { changes: Number(r.changes) } };
        },
        async first() {
          return sql.prepare(query).get(...(args as never[])) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...(args as never[])) };
        },
      };
      return stmt;
    },
    async batch(stmts: { run: () => Promise<unknown> }[]) {
      sql.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return db as unknown as D1Database;
}
const result = encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
  [sample.wallet as `0x${string}`, sample.recipient as `0x${string}`, 3n],
);
export function fakeClient(now = Date.now()) {
  return {
    getChainId: vi.fn(async () => 4663),
    getBlock: vi.fn(async () => ({
      number: 100n,
      hash: '0x' + '11'.repeat(32),
      timestamp: BigInt(Math.floor(now / 1000)),
    })),
    getCode: vi.fn(async () => '0x6001'),
    readContract: vi.fn(
      async (x: { functionName: string }) =>
        ({
          factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
          canLaunch: true,
          launchConfigCount: 1n,
          getLaunchConfig: { enabled: true, supply: 1000n, curveFeeBps: 30n },
          launchFee: 7n,
          maxCreatorTaxBps: 1000n,
          previewLaunchEconomics: '0x' + '22'.repeat(32),
        })[x.functionName],
    ),
    getBalance: vi.fn(async () => 10n ** 20n),
    getTransactionCount: vi.fn(async () => 8),
    getGasPrice: vi.fn(async () => 100n),
    call: vi.fn(async () => ({ data: result })),
    estimateGas: vi.fn(async () => 500000n),
  };
}
