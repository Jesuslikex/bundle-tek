// Provider Racing: broadcast the SAME signed transaction through several
// independent providers at once and accept the first that echoes its
// signature. Identical bytes carry one signature, so this can never execute
// twice; it only improves the chance one provider forwards it quickly.

/** Extra public senders used alongside the configured primary RPC. */
export const RACE_PROVIDERS = [
  'https://api.mainnet-beta.solana.com',
  'https://mainnet.block-engine.jito.wtf/api/v1/transactions',
] as const;

export type RaceSend = (
  endpoint: string,
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;

/**
 * Sends `transaction` (base64) to the primary endpoint and, when `race` is
 * true, to every RACE_PROVIDERS endpoint in parallel. Resolves with the
 * signature once any provider returns exactly `signature`; rejects only when
 * every provider failed or returned something else.
 */
export async function raceSendTransaction(input: {
  primary: string;
  transaction: string;
  signature: string;
  race: boolean;
  signal: AbortSignal;
  send: RaceSend;
  providers?: readonly string[];
}) {
  const endpoints = [
    input.primary,
    ...(input.race ? (input.providers ?? RACE_PROVIDERS) : []),
  ].filter((e, i, all) => all.indexOf(e) === i);
  const params = [
    input.transaction,
    {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 0,
    },
  ];
  return Promise.any(
    endpoints.map(async (endpoint) => {
      const returned = await input.send(
        endpoint,
        'sendTransaction',
        params,
        input.signal,
      );
      if (returned !== input.signature)
        throw new Error('Provider returned a different signature.');
      return { signature: input.signature, endpoint };
    }),
  );
}
