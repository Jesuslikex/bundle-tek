export const DEVNET_GENESIS_HASH =
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const DEVNET_PREFLIGHT_LIFETIME_MS = 60_000;

type GenesisRpc = {
  getGenesisHash(): {
    send(options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  };
};

export async function requireDevnet(rpc: GenesisRpc): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hash = await Promise.race([
      rpc.getGenesisHash().send({ abortSignal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new Error('Devnet identity check timed out. Run preflight again.'),
          );
        }, 10_000);
      }),
    ]);
    if (hash !== DEVNET_GENESIS_HASH) {
      throw new Error(
        'RPC network is not Solana devnet. Wallet approval is blocked.',
      );
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export type DevnetPreflight = {
  identity: string;
  expiresAt: number;
  revision: number;
};

export function isCurrentPreflight(
  preflight: DevnetPreflight | null,
  identity: string | null,
  revision: number,
  now = Date.now(),
): boolean {
  return (
    !!preflight &&
    !!identity &&
    preflight.identity === identity &&
    preflight.revision === revision &&
    Number.isFinite(preflight.expiresAt) &&
    preflight.expiresAt > now &&
    preflight.expiresAt <= now + DEVNET_PREFLIGHT_LIFETIME_MS
  );
}

// Every awaited step must retain the same wallet and reviewed inputs.
export class DevnetIntentScope {
  private revision = 0;
  capture() {
    return this.revision;
  }
  invalidate() {
    this.revision += 1;
  }
  isCurrent(revision: number) {
    return revision === this.revision;
  }
  assertCurrent(revision: number) {
    if (!this.isCurrent(revision))
      throw new Error(
        'Wallet or reviewed inputs changed. Run preflight again.',
      );
  }
}
