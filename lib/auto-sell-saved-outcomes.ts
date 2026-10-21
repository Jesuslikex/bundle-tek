import { importedApprovalPage } from './imported-approval-history';
import { transactionSignature } from './transaction-signature';
import { UUID } from './wallet-operation';
const SOL = 'So11111111111111111111111111111111111111112';
const publicAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const AUTO_SELL_SAVED_RESPONSE_BYTES = 1_048_576;
export type AutoSellSavedSelection = {
  projectId: string;
  mint: string;
  intentId?: string | null;
  cursor?: string | null;
};
const unavailable = () =>
  Error('Saved Sell history is unavailable or its context differs.');
export function autoSellSavedSelection(value: AutoSellSavedSelection) {
  if (
    !UUID.test(value.projectId) ||
    !publicAddress.test(value.mint) ||
    (value.intentId != null && !UUID.test(value.intentId)) ||
    (value.cursor != null && !UUID.test(value.cursor)) ||
    (value.intentId != null && value.cursor != null)
  )
    throw unavailable();
  return {
    projectId: value.projectId,
    mint: value.mint,
    intentId: value.intentId ?? null,
    cursor: value.cursor ?? null,
  };
}
/** Project saved state only. No packet, receipt proof or execution capability is returned. */
export function autoSellSavedOutcomePage(
  value: unknown,
  selection: AutoSellSavedSelection,
) {
  const context = autoSellSavedSelection(selection);
  const page = importedApprovalPage(value, context.projectId);
  if (
    (context.cursor && page.intents.some((row) => row.id === context.cursor)) ||
    (context.intentId &&
      (page.intents.length !== 1 ||
        page.intents[0].id !== context.intentId ||
        page.nextCursor !== null)) ||
    (page.nextCursor !== null &&
      (page.intents.length !== 50 ||
        page.intents.at(-1)!.id !== page.nextCursor ||
        page.nextCursor === context.cursor))
  )
    throw unavailable();
  const rows = page.intents.flatMap((row) => {
    if (row.side !== 'Sell') return [];
    if (row.document.inputMint !== context.mint) throw unavailable();
    if (row.document.outputMint !== SOL) return [];
    if (
      !publicAddress.test(row.wallet) ||
      typeof row.updatedAt !== 'string' ||
      row.updatedAt.length > 64 ||
      !Number.isFinite(Date.parse(row.updatedAt)) ||
      typeof row.document.inputRaw !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(row.document.inputRaw) ||
      BigInt(row.document.inputRaw) > (1n << 64n) - 1n
    )
      throw unavailable();
    if (row.signature !== null) transactionSignature(row.signature);
    return [
      Object.freeze({
        intentId: row.id,
        preparationId: row.preparationId,
        projectRevision: row.projectRevision,
        walletRevision: row.walletRevision,
        wallet: row.wallet,
        inputRaw: row.document.inputRaw,
        state: row.state,
        signature: row.signature,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        finalityVerified: false as const,
        signingAllowed: false as const,
        submissionAllowed: false as const,
      }),
    ];
  });
  return Object.freeze({
    rows: Object.freeze(rows),
    scanned: page.intents.length,
    nextCursor: page.nextCursor,
    finalityVerified: false as const,
    signingAllowed: false as const,
    submissionAllowed: false as const,
  });
}
export async function readAutoSellSavedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
  } catch {
    throw unavailable();
  }
  if (!reader) throw unavailable();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (
      Number(response.headers.get('content-length')) >
      AUTO_SELL_SAVED_RESPONSE_BYTES
    )
      throw unavailable();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0,
      text = '';
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > AUTO_SELL_SAVED_RESPONSE_BYTES) throw unavailable();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    throw unavailable();
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
