import type {
  WalletOperation,
  WalletOperationDocument,
} from './wallet-operation';
import { WalletSigningRejected } from './wallet-signing-rejection';
export async function operationRequest(body: unknown) {
  const response = await fetch('/api/wallet/operations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as {
    operation?: WalletOperation;
    error?: string;
  };
  if (!response.ok || !result.operation)
    throw new Error(result.error || 'Wallet operation unavailable.');
  return result.operation;
}
export async function runOwnedWalletOperation(
  document: WalletOperationDocument,
  assertReady: () => void,
  send: (
    recordSignature: (signature: string) => Promise<void>,
  ) => Promise<string>,
  onSignature: (signature: string, id: string) => void,
) {
  const id = crypto.randomUUID(),
    claim = crypto.randomUUID();
  let armed = false,
    capturedSignature: string | undefined;
  try {
    const reservation = await operationRequest({
      action: 'reserve',
      id,
      claim,
      document,
    });
    if (reservation.id !== id || reservation.state !== 'preparing')
      throw new Error('Approval reservation is not available.');
    assertReady();
    // A lost arm response is uncertain too. Never automatically release after attempting it.
    armed = true;
    const approval = await operationRequest({ action: 'arm', id, claim });
    if (approval.id !== id || approval.state !== 'awaiting_signature')
      throw new Error('Approval reservation was not confirmed.');
    assertReady();
    let registration: Promise<void> | undefined;
    const recordSignature = (signature: string) => {
      if (capturedSignature && capturedSignature !== signature)
        throw new Error('One reservation cannot submit another transaction.');
      capturedSignature = signature;
      return (registration ??= (async () => {
        let localError: unknown;
        try {
          onSignature(signature, id);
        } catch (error) {
          localError = error;
        }
        const saved = await operationRequest({
          action: 'submitted',
          id,
          claim,
          signature,
        });
        if (
          saved.id !== id ||
          saved.state !== 'submitted' ||
          saved.signature !== signature
        )
          throw new Error('Signed transaction registration was not confirmed.');
        if (localError) throw localError;
      })());
    };
    const signature = await send(recordSignature);
    if (!registration || signature !== capturedSignature)
      throw new Error(
        'Wallet did not provide a recoverable signed transaction.',
      );
    await registration;
    return { signature, id };
  } catch (error) {
    if (armed && !capturedSignature && error instanceof WalletSigningRejected) {
      try {
        const cancelled = await operationRequest({
          action: 'rejected',
          id,
          claim,
        });
        if (
          cancelled.id !== id ||
          cancelled.state !== 'cancelled' ||
          cancelled.signature
        )
          throw new Error('Rejection acknowledgement mismatch.');
      } catch (recoveryError) {
        throw new Error(
          'Signing was rejected, but reservation release was not confirmed. Refresh the pending operation before trying again.',
          { cause: recoveryError },
        );
      }
    }
    if (!armed)
      try {
        await operationRequest({ action: 'cancel', id, claim });
      } catch {
        /* Recovery reads the retained server state after an uncertain response. */
      }
    throw error;
  }
}
