import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import {
  address,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  assertIsTransactionWithinSizeLimit,
  signTransactionMessageWithSigners,
  type SignatureBytes,
  type TransactionModifyingSigner,
  type TransactionPartialSigner,
  type Transaction,
} from '@solana/kit';
import {
  receiptKeyPair,
  receiptWallet,
  receiptRecipient,
  receiptMint,
} from '../test/devnet-receipt-fixture';
import {
  recoverableWalletSigner,
  assertRecoverableWalletSigner,
} from './recoverable-wallet-signer';
import { createWalletSubmissionClient } from './wallet-submission-client';
import type { AppClient } from './solana-client';
import {
  VaultApprovalCancelled,
  WalletSigningRejected,
} from './wallet-signing-rejection';

function unsigned() {
  const msg = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: blockhash('11111111111111111111111111111111'),
      lastValidBlockHeight: 100n,
    },
    setTransactionMessageFeePayer(
      address(receiptWallet),
      createTransactionMessage({ version: 0 }),
    ),
  );
  const tx = compileTransaction(msg);
  assertIsTransactionWithinSizeLimit(tx);
  return tx;
}
function signed(tx: Transaction) {
  return {
    ...tx,
    signatures: {
      [receiptWallet]: nacl.sign.detached(
        new Uint8Array(tx.messageBytes),
        receiptKeyPair.secretKey,
      ) as SignatureBytes,
    },
  };
}
const partial: TransactionPartialSigner = {
  address: address(receiptWallet),
  signTransactions: async (transactions) =>
    transactions.map((tx) => signed(tx).signatures),
};
function modifying(
  change?: (tx: Transaction) => Transaction,
): TransactionModifyingSigner {
  return {
    address: address(receiptWallet),
    modifyAndSignTransactions: async (transactions) =>
      transactions.map((tx) => {
        const result = signed(change ? change(tx) : tx);
        assertIsTransactionWithinSizeLimit(result);
        return { ...result, lifetimeConstraint: unsigned().lifetimeConstraint };
      }),
  };
}
describe('recoverable wallet signing', () => {
  it('marks explicit signing-only rejection but preserves unknown errors', async () => {
    for (const failure of [{ code: 4001 }, new VaultApprovalCancelled()]) {
      const record = vi.fn();
      const signer = {
        ...partial,
        signTransactions: async () => {
          throw failure;
        },
      };
      await expect(
        recoverableWalletSigner(
          signer,
          record,
          () => {},
        ).modifyAndSignTransactions([unsigned()]),
      ).rejects.toBeInstanceOf(WalletSigningRejected);
      expect(record).not.toHaveBeenCalled();
    }
    for (const failure of [
      new Error('User rejected'),
      { code: '4001' },
      { code: -32603 },
      { cause: { code: 4001 } },
    ]) {
      const signer = {
        ...partial,
        signTransactions: async () => {
          throw failure;
        },
      };
      await expect(
        recoverableWalletSigner(
          signer,
          vi.fn(),
          () => {},
        ).modifyAndSignTransactions([unsigned()]),
      ).rejects.toBe(failure);
    }
  });
  it('does not mark a rejection-like registration error after a signed result', async () => {
    const failure = { code: 4001 };
    await expect(
      recoverableWalletSigner(
        partial,
        async () => {
          throw failure;
        },
        () => {},
      ).modifyAndSignTransactions([unsigned()]),
    ).rejects.toBe(failure);
  });
  it('waits for durable signature acknowledgement before releasing a signed transaction to the sender', async () => {
    let release!: () => void;
    const ack = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = vi.fn(() => ack),
      ready = vi.fn();
    const wrapper = recoverableWalletSigner(partial, record, ready);
    let returned = false;
    const pending = wrapper
      .modifyAndSignTransactions([unsigned()])
      .then((value) => {
        returned = true;
        return value;
      });
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(returned).toBe(false);
    release();
    await pending;
    expect(ready).toHaveBeenCalledTimes(2);
  });
  it('retains a signed identity after an input change but does not return it for broadcast', async () => {
    const record = vi.fn(async () => {});
    let count = 0;
    const wrapper = recoverableWalletSigner(partial, record, () => {
      if (++count === 2) throw new Error('Changed review');
    });
    await expect(
      wrapper.modifyAndSignTransactions([unsigned()]),
    ).rejects.toThrow('Changed review');
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('does not release a transaction if registration fails or approval is rejected', async () => {
    const wrapper = recoverableWalletSigner(
      partial,
      async () => {
        throw new Error('Lost registration');
      },
      () => {},
    );
    await expect(
      wrapper.modifyAndSignTransactions([unsigned()]),
    ).rejects.toThrow('Lost registration');
    const record = vi.fn();
    const rejected: TransactionModifyingSigner = {
      address: address(receiptWallet),
      modifyAndSignTransactions: async () => {
        throw new Error('Wallet rejected');
      },
    };
    await expect(
      recoverableWalletSigner(
        rejected,
        record,
        () => {},
      ).modifyAndSignTransactions([unsigned()]),
    ).rejects.toThrow('Wallet rejected');
    expect(record).not.toHaveBeenCalled();
  });
  it('rejects changed message bytes, lifetime and invalid signatures before registration', async () => {
    const record = vi.fn(async () => {});
    const changed = modifying((tx) => {
      const bytes = new Uint8Array(tx.messageBytes);
      bytes[bytes.length - 1] ^= 1;
      return {
        ...tx,
        messageBytes: bytes as unknown as typeof tx.messageBytes,
      };
    });
    await expect(
      recoverableWalletSigner(
        changed,
        record,
        () => {},
      ).modifyAndSignTransactions([unsigned()]),
    ).rejects.toThrow('changed');
    const lifetime = modifying();
    const wrongLifetime: TransactionModifyingSigner = {
      ...lifetime,
      modifyAndSignTransactions: async (txs, config) =>
        (await lifetime.modifyAndSignTransactions(txs, config)).map((tx) => ({
          ...tx,
          lifetimeConstraint: {
            blockhash: unsigned().lifetimeConstraint.blockhash,
            lastValidBlockHeight: 101n,
          },
        })),
    };
    await expect(
      recoverableWalletSigner(
        wrongLifetime,
        record,
        () => {},
      ).modifyAndSignTransactions([unsigned()]),
    ).rejects.toThrow('changed');
    const invalid: TransactionPartialSigner = {
      ...partial,
      signTransactions: async () => [
        { [receiptWallet]: new Uint8Array(64).fill(9) as SignatureBytes },
      ],
    };
    await expect(
      recoverableWalletSigner(
        invalid,
        record,
        () => {},
      ).modifyAndSignTransactions([unsigned()]),
    ).rejects.toThrow('invalid transaction signature');
    expect(record).not.toHaveBeenCalled();
  });
  it('rejects combined-send-only wallets and multiple transaction approvals', async () => {
    expect(() =>
      assertRecoverableWalletSigner({
        address: address(receiptWallet),
        signAndSendTransactions: async () => [],
      }),
    ).toThrow('combined signing');
    const record = vi.fn();
    await expect(
      recoverableWalletSigner(
        partial,
        record,
        () => {},
      ).modifyAndSignTransactions([unsigned(), unsigned()]),
    ).rejects.toThrow('exactly one');
    expect(record).not.toHaveBeenCalled();
  });
  it.each(['memo', 'spl'])(
    'uses the tracked signer in the installed SDK %s builder and signing engine',
    async (kind) => {
      const recorded = vi.fn(async () => {});
      const base = { rpc: {}, rpcSubscriptions: {} } as Pick<
        AppClient,
        'rpc' | 'rpcSubscriptions'
      >;
      const client = createWalletSubmissionClient(
        base,
        partial,
        recorded,
        () => {},
      );
      const builder =
        kind === 'memo'
          ? client.memo.instructions.addMemo({
              memo: 'PulseForge verified devnet wallet offline QA',
              signers: [client.payer],
            })
          : client.token.instructions.transferToATA({
              payer: client.payer,
              authority: client.payer,
              mint: address(receiptMint),
              recipient: address(receiptRecipient),
              amount: 300000001n,
              decimals: 9,
            });
      const message = await builder.planTransaction();
      const prepared = setTransactionMessageLifetimeUsingBlockhash(
        unsigned().lifetimeConstraint,
        message,
      );
      const result = await signTransactionMessageWithSigners(prepared);
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(Object.keys(result.signatures)).toEqual([receiptWallet]);
    },
  );
});
