import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import bs58 from 'bs58';
import { TOKEN_2022_PROGRAM } from '../lib/stonkfun-launch';

/** Synthetic simulateBundle result: holder base token accounts hold `amounts`. */
export async function fakeBundleSimulation(
  params: unknown[],
  mint: string,
  amounts: Record<string, bigint>,
  summary: unknown = 'succeeded',
) {
  const owners = new Map<string, string>();
  for (const holder of Object.keys(amounts)) {
    const [ata] = await findAssociatedTokenPda({
      mint: address(mint),
      owner: address(holder),
      tokenProgram: address(TOKEN_2022_PROGRAM),
    });
    owners.set(ata, holder);
  }
  const [bundle, config] = params as [
    { encodedTransactions: string[] },
    { postExecutionAccountsConfigs: ({ addresses: string[] } | null)[] },
  ];
  return {
    context: { slot: 200 },
    value: {
      summary,
      transactionResults: bundle.encodedTransactions.map((_, i) => ({
        err: null,
        postExecutionAccounts:
          config.postExecutionAccountsConfigs[i]?.addresses.map((a) => {
            const holder = owners.get(a)!;
            const data = new Uint8Array(170);
            data.set(bs58.decode(mint), 0);
            data.set(bs58.decode(holder), 32);
            new DataView(data.buffer).setBigUint64(64, amounts[holder], true);
            return {
              data: [Buffer.from(data).toString('base64'), 'base64'],
              owner: TOKEN_2022_PROGRAM,
              lamports: 2074080,
            };
          }) ?? null,
      })),
    },
  };
}
