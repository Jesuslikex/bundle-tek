// Withdraw one wallet to a destination by driving the existing cleanup pipeline.
// The captured delete flow withdraws first and only then deletes, so this is the
// "withdraw" half; the caller archives on success.
//
// The panel keeps its own copy of this sequence for multi-wallet batches. That
// duplication is deliberate: the panel's version is woven through its own state,
// and rewiring it risked the working path.
import { unlockVault, VAULT_STORAGE_KEY } from './browser-wallet-vault';
import {
  CLEANUP_DEFAULT_DELAY_MS,
  CLEANUP_DEFAULT_MAX_DELAY_MS,
  cleanupPayload,
} from './wallet-cleanup-plan';
import {
  signWalletCleanupBatch,
  validatedWalletCleanup,
  type WalletCleanup,
} from './wallet-cleanup';

export type WithdrawStep = 'preparing' | 'signing' | 'submitting';

export type WithdrawResult = {
  batchId: string;
  submitted: number;
  failures: string[];
};

export class WalletWithdrawError extends Error {}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(body: object, signal?: AbortSignal) {
  const response = await fetch('/api/wallet-workspace/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const value = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok)
    throw new WalletWithdrawError(value.error || 'Cleanup request failed.');
  return value as Record<string, unknown>;
}

// Only rows still waiting on a signature need rejecting; anything already
// signed can still settle.
const PENDING = ['awaiting_signature', 'signing', 'pending'];

export async function withdrawWalletTo(input: {
  walletAddress: string;
  destination: string;
  password: string;
  signal?: AbortSignal;
  onStep?: (step: WithdrawStep) => void;
}): Promise<WithdrawResult> {
  const { walletAddress, destination, password, signal, onStep } = input;
  if (!password) throw new WalletWithdrawError('Enter the vault password.');
  if (walletAddress === destination)
    throw new WalletWithdrawError(
      'The destination must differ from the wallet being emptied.',
    );

  const payload = cleanupPayload({
    inputWalletPubkeys: [walletAddress],
    outputWalletPubkeys: [destination],
    minDelayMs: CLEANUP_DEFAULT_DELAY_MS,
    maxDelayMs: CLEANUP_DEFAULT_MAX_DELAY_MS,
    doubleBuyPct: 0,
    fakeTipPct: 0,
  });

  onStep?.('preparing');
  const prepared = (await request(
    { action: 'run', ...payload },
    signal,
  )) as unknown as { batchId: string; cleanups: unknown[] };
  const batchId = prepared.batchId;
  const cleanups = await Promise.all(
    (prepared.cleanups ?? []).map((row) => validatedWalletCleanup(row)),
  );
  const pending = cleanups.filter((row) => PENDING.includes(row.state));
  if (!pending.length)
    throw new WalletWithdrawError(
      'Nothing to withdraw from this wallet; it holds no swept balance.',
    );

  // Unlock before begin_signing: that call may re-quote and must not spend the
  // blockhash window on key derivation.
  const session = await unlockVault(
    localStorage.getItem(VAULT_STORAGE_KEY) || '',
    password,
  );
  let begun = false;
  let signedAny = false;
  try {
    onStep?.('signing');
    const started = (await request(
      { action: 'begin_signing', batchId },
      signal,
    )) as unknown as { cleanups: WalletCleanup[] };
    begun = true;
    // Sign the server's fresh copies, not the local ones it may have re-quoted.
    const reviews = (started.cleanups ?? [])
      .filter((row) => row.state === 'signing')
      .map((row) => row.document);
    const signed = await signWalletCleanupBatch(session, reviews, () =>
      signal?.throwIfAborted(),
    );
    signedAny = true;

    onStep?.('submitting');
    const failures: string[] = [];
    let submitted = 0;
    let index = 0;
    for (const entry of signed) {
      try {
        if (index++ > 0) await pause(CLEANUP_DEFAULT_DELAY_MS);
        await request(
          { action: 'register', id: entry.id, transaction: entry.transaction },
          signal,
        );
        await request(
          { action: 'submit', id: entry.id, transaction: entry.transaction },
          signal,
        );
        submitted += 1;
      } catch (error) {
        failures.push(
          error instanceof Error ? error.message : 'Submit failed.',
        );
      }
    }
    if (!submitted && failures.length)
      throw new WalletWithdrawError(failures.join(' '));
    return { batchId, submitted, failures };
  } catch (error) {
    // Nothing was signed, so release the claimed rows instead of stranding them.
    if (begun && !signedAny)
      for (const row of pending)
        await request({
          action: 'reject_signing',
          id: row.id,
          noSignatureVerified: true,
        }).catch(() => undefined);
    throw error;
  } finally {
    session.payload.wallets.forEach((wallet) => {
      wallet.seed = '';
    });
    session.payload.wallets.length = 0;
  }
}
