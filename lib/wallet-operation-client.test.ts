import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOwnedWalletOperation } from './wallet-operation-client';
import { WalletSigningRejected } from './wallet-signing-rejection';
import {
  receiptWallet,
  receiptSignature,
} from '../test/devnet-receipt-fixture';
afterEach(() => vi.unstubAllGlobals());
describe('owned wallet approval sequencing', () => {
  function server(fail?: string) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        calls.push(body.action);
        if (body.action === fail) throw new Error('Lost server response');
        return Response.json({
          operation: {
            id: body.id,
            signature: body.signature,
            state:
              body.action === 'reserve'
                ? 'preparing'
                : body.action === 'arm'
                  ? 'awaiting_signature'
                  : body.action === 'submitted'
                    ? 'submitted'
                    : 'cancelled',
          },
        });
      }),
    );
    return calls;
  }
  const doc = { kind: 'memo' as const, wallet: receiptWallet };
  it('releases only a definite signing rejection before signature capture', async () => {
    const calls = server();
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {},
        async () => {
          throw new WalletSigningRejected({ code: 4001 });
        },
        () => {},
      ),
    ).rejects.toThrow('signing was rejected');
    expect(calls).toEqual(['reserve', 'arm', 'rejected']);
  });
  it('retains captured signatures even if a later error resembles rejection', async () => {
    const calls = server();
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {},
        async (record) => {
          await record(receiptSignature);
          throw new WalletSigningRejected({ code: 4001 });
        },
        () => {},
      ),
    ).rejects.toThrow('signing was rejected');
    expect(calls).toEqual(['reserve', 'arm', 'submitted']);
  });
  it('reports an uncertain release acknowledgement and never repeats approval', async () => {
    const calls = server('rejected');
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {},
        async () => {
          throw new WalletSigningRejected({ code: 4001 });
        },
        () => {},
      ),
    ).rejects.toThrow('release was not confirmed');
    expect(calls).toEqual(['reserve', 'arm', 'rejected']);
  });
  it('does not interpret arbitrary downstream provider codes as signing rejection', async () => {
    const calls = server();
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {},
        async () => {
          throw { code: 4001 };
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 4001 });
    expect(calls).toEqual(['reserve', 'arm']);
  });
  it('reserves and arms before requesting a transaction, then records its signature', async () => {
    const calls = server(),
      send = vi.fn(
        async (recordSignature: (signature: string) => Promise<void>) => {
          expect(calls).toEqual(['reserve', 'arm']);
          await recordSignature(receiptSignature);
          return receiptSignature;
        },
      ),
      stored = vi.fn();
    await expect(
      runOwnedWalletOperation(doc, () => {}, send, stored),
    ).resolves.toMatchObject({ signature: receiptSignature });
    expect(calls).toEqual(['reserve', 'arm', 'submitted']);
    expect(stored).toHaveBeenCalledWith(receiptSignature, expect.any(String));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not request approval if reservation fails or reviewed inputs change', async () => {
    let calls = server('reserve');
    const send = vi.fn();
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {},
        send,
        () => {},
      ),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(calls).toEqual(['reserve', 'cancel']);
    calls = server();
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {
          throw new Error('Stale review');
        },
        send,
        () => {},
      ),
    ).rejects.toThrow('Stale review');
    expect(calls).toEqual(['reserve', 'cancel']);
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps an uncertain arm or SDK outcome unresolved without automatically cancelling', async () => {
    let calls = server('arm');
    const send = vi.fn();
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {},
        send,
        () => {},
      ),
    ).rejects.toThrow();
    expect(calls).toEqual(['reserve', 'arm']);
    expect(send).not.toHaveBeenCalled();
    calls = server();
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {},
        async () => {
          throw new Error('Unknown wallet result');
        },
        () => {},
      ),
    ).rejects.toThrow('Unknown wallet result');
    expect(calls).toEqual(['reserve', 'arm']);
  });
  it('records the durable signature even if local storage fails', async () => {
    const calls = server();
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {},
        async (recordSignature) => {
          await recordSignature(receiptSignature);
          return receiptSignature;
        },
        () => {
          throw new Error('Local quota');
        },
      ),
    ).rejects.toThrow('Local quota');
    expect(calls).toEqual(['reserve', 'arm', 'submitted']);
  });
  it('preserves a returned signature locally if its server registration response is lost', async () => {
    const calls = server('submitted'),
      stored = vi.fn();
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {},
        async (recordSignature) => {
          await recordSignature(receiptSignature);
          return receiptSignature;
        },
        stored,
      ),
    ).rejects.toThrow();
    expect(stored).toHaveBeenCalledWith(receiptSignature, expect.any(String));
    expect(calls).toEqual(['reserve', 'arm', 'submitted']);
  });
  it('preserves identity before a lost broadcast response and never cancels the armed operation', async () => {
    const calls = server(),
      stored = vi.fn();
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {},
        async (record) => {
          await record(receiptSignature);
          expect(calls).toEqual(['reserve', 'arm', 'submitted']);
          expect(stored).toHaveBeenCalledWith(
            receiptSignature,
            expect.any(String),
          );
          throw new Error('Broadcast response lost');
        },
        stored,
      ),
    ).rejects.toThrow('Broadcast response lost');
    expect(calls).toEqual(['reserve', 'arm', 'submitted']);
  });
  it('deduplicates one signed identity and refuses another under the same reservation', async () => {
    const calls = server(),
      stored = vi.fn();
    await expect(
      runOwnedWalletOperation(
        doc,
        () => {},
        async (record) => {
          await record(receiptSignature);
          await record(receiptSignature);
          await record('another');
          return receiptSignature;
        },
        stored,
      ),
    ).rejects.toThrow('another transaction');
    expect(calls).toEqual(['reserve', 'arm', 'submitted']);
    expect(stored).toHaveBeenCalledTimes(1);
  });
});
