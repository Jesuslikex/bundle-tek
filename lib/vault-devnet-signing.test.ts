import { beforeAll, describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  address,
  blockhash,
  compileTransaction,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageComputeUnitLimit,
  appendTransactionMessageInstruction,
  AccountRole,
  type TransactionPartialSigner,
} from '@solana/kit';
import {
  createVault,
  importVaultWallets,
  encryptVault,
  unlockVault,
  type VaultSession,
} from './browser-wallet-vault';
import {
  inspectVaultDevnetTransaction,
  signVaultDevnetTransaction,
  inspectVaultDevnetOwnership,
  signVaultDevnetOwnership,
} from './vault-devnet-signing';
import { createWalletSubmissionClient } from './wallet-submission-client';
import { operationDocument, type WalletOperation } from './wallet-operation';
import { createWalletChallenge } from './wallet-verification';
import {
  receiptWallet,
  receiptKeyPair,
  receiptClaim,
  receiptMint,
  receiptRecipient,
  nativeFundingInput,
} from '../test/devnet-receipt-fixture';
import type { AppClient } from './solana-client';
let session: VaultSession;
const password = 'offline test only password';
beforeAll(async () => {
  session = importVaultWallets(
    await createVault(password),
    'solana',
    bs58.encode(receiptKeyPair.secretKey),
  ).session;
});
async function fixture(kind: 'memo' | 'spl' | 'sol' | 'funding_spl' = 'memo') {
  const signer: TransactionPartialSigner = {
    address: address(receiptWallet),
    signTransactions: async () => [],
  };
  const client = createWalletSubmissionClient(
    { rpc: {}, rpcSubscriptions: {} } as Pick<
      AppClient,
      'rpc' | 'rpcSubscriptions'
    >,
    signer,
    async () => {},
    () => {},
  );
  const builder =
    kind === 'memo'
      ? client.memo.instructions.addMemo({
          memo: 'PulseForge verified devnet wallet offline QA',
          signers: [client.payer],
        })
      : kind === 'sol'
        ? client.system.instructions.transferSol({
            source: client.payer,
            destination: address(receiptRecipient),
            amount: 300000001n,
          })
        : client.token.instructions.transferToATA({
            payer: client.payer,
            authority: client.payer,
            mint: address(receiptMint),
            recipient: address(receiptRecipient),
            amount: kind === 'funding_spl' ? 300001n : 300000001n,
            decimals: kind === 'funding_spl' ? 6 : 9,
          });
  const message = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: blockhash('11111111111111111111111111111111'),
      lastValidBlockHeight: 100n,
    },
    setTransactionMessageComputeUnitLimit(
      1400000,
      await builder.planTransaction(),
    ),
  );
  const doc = await operationDocument(
    kind === 'memo'
      ? { kind, wallet: receiptWallet }
      : kind === 'sol'
        ? nativeFundingInput
        : {
            kind: 'spl',
            ...(kind === 'funding_spl'
              ? { funding: { id: 'funding-test', revision: 1 } }
              : {}),
            wallet: receiptWallet,
            distribution:
              kind === 'funding_spl'
                ? {
                    ...receiptClaim,
                    recipients: [
                      { address: receiptRecipient, amount: '0.300001' },
                    ],
                  }
                : receiptClaim,
            recipient: receiptRecipient,
          },
  );
  const now = new Date().toISOString();
  const op: WalletOperation = {
    id: crypto.randomUUID(),
    walletAddress: receiptWallet,
    kind,
    document: JSON.stringify(doc),
    state: 'awaiting_signature',
    signature: null,
    createdAt: now,
    armedAt: now,
    expiresAt: now,
    minimumSlot: 100,
    updatedAt: now,
  };
  return { tx: compileTransaction(message), message, op };
}
describe('explicit browser-vault devnet signing', () => {
  it('signs saved SPL funding with captured decimals and refuses a different decimal encoding', async () => {
    const { tx, op } = await fixture('funding_spl');
    expect(
      await inspectVaultDevnetTransaction(tx, op, receiptWallet),
    ).toMatchObject({ kind: 'spl', amount: '0.300001', mint: receiptMint });
    const signature = await signVaultDevnetTransaction(
      session,
      receiptWallet,
      tx,
      op,
      () => {},
    );
    expect(
      nacl.sign.detached.verify(
        new Uint8Array(tx.messageBytes),
        new Uint8Array(signature),
        receiptKeyPair.publicKey,
      ),
    ).toBe(true);
    const other = await fixture('spl');
    const doc = JSON.parse(other.op.document);
    doc.funding = { id: 'funding-test', revision: 1, key: 'ignored' };
    other.op.document = JSON.stringify(await operationDocument(doc));
    await expect(
      inspectVaultDevnetTransaction(other.tx, other.op, receiptWallet),
    ).rejects.toThrow('differs');
  });
  it('signs the installed SDK native SOL funding bytes and refuses a changed amount', async () => {
    const { tx, op } = await fixture('sol');
    expect(
      await inspectVaultDevnetTransaction(tx, op, receiptWallet),
    ).toMatchObject({
      kind: 'sol',
      amount: '0.300000001',
      recipient: receiptRecipient,
      createsAccount: false,
    });
    const signature = await signVaultDevnetTransaction(
      session,
      receiptWallet,
      tx,
      op,
      () => {},
    );
    expect(
      nacl.sign.detached.verify(
        new Uint8Array(tx.messageBytes),
        new Uint8Array(signature),
        receiptKeyPair.publicKey,
      ),
    ).toBe(true);
    const changed = await operationDocument({
      ...nativeFundingInput,
      amount: '0.3',
    });
    await expect(
      inspectVaultDevnetTransaction(
        tx,
        { ...op, document: JSON.stringify(changed) },
        receiptWallet,
      ),
    ).rejects.toThrow('differs');
  });
  it.each(['memo', 'spl'] as const)(
    'decodes the actual SDK %s transaction and signs only the reviewed bytes',
    async (kind) => {
      const { tx, op } = await fixture(kind);
      const encrypted = await encryptVault(session),
        unlocked = await unlockVault(encrypted, password);
      const review = await inspectVaultDevnetTransaction(tx, op, receiptWallet);
      expect(review).toMatchObject({
        kind,
        wallet: receiptWallet,
        maximumNetworkFeeLamports: '6400',
        createsAccount: kind === 'spl',
      });
      if (kind === 'spl')
        expect(review).toMatchObject({
          amount: '0.300000001',
          mint: receiptMint,
          recipient: receiptRecipient,
        });
      const sig = await signVaultDevnetTransaction(
        unlocked,
        receiptWallet,
        tx,
        op,
        () => {},
      );
      expect(
        nacl.sign.detached.verify(
          new Uint8Array(tx.messageBytes),
          new Uint8Array(sig),
          receiptKeyPair.publicKey,
        ),
      ).toBe(true);
      expect(encrypted).not.toContain(receiptWallet);
    },
  );
  it('rejects missing, already-signed and differently owned reservations', async () => {
    const { tx, op } = await fixture();
    for (const patch of [
      { walletAddress: receiptRecipient },
      { state: 'submitted' as const },
      { signature: 'existing' },
      { armedAt: null },
    ])
      await expect(
        inspectVaultDevnetTransaction(tx, { ...op, ...patch }, receiptWallet),
      ).rejects.toThrow();
  });
  it('rejects changed amounts, recipients and additional native transfers', async () => {
    const { tx, op, message } = await fixture('spl');
    const doc = JSON.parse(op.document);
    doc.distribution.recipients[0].amount = '0.3';
    await expect(
      inspectVaultDevnetTransaction(
        tx,
        { ...op, document: JSON.stringify(doc) },
        receiptWallet,
      ),
    ).rejects.toThrow();
    const extra = appendTransactionMessageInstruction(
      {
        programAddress: address('11111111111111111111111111111111'),
        accounts: [
          {
            address: address(receiptWallet),
            role: AccountRole.WRITABLE_SIGNER,
          },
          { address: address(receiptRecipient), role: AccountRole.WRITABLE },
        ],
        data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
      },
      message,
    );
    await expect(
      inspectVaultDevnetTransaction(
        compileTransaction(extra),
        op,
        receiptWallet,
      ),
    ).rejects.toThrow();
  });
  it('rejects arbitrary, wrong-origin and expired ownership messages', () => {
    const now = Date.now(),
      id = crypto.randomUUID(),
      issued = new Date(now).toISOString();
    const text =
      createWalletChallenge(receiptWallet, id, issued) +
      '\nOrigin: http://localhost\nAccount: offline-user';
    const bytes = new TextEncoder().encode(text);
    expect(
      inspectVaultDevnetOwnership(
        bytes,
        receiptWallet,
        'http://localhost',
        now,
      ),
    ).toMatchObject({ account: 'offline-user' });
    const sig = signVaultDevnetOwnership(
      session,
      receiptWallet,
      bytes,
      'http://localhost',
      () => {},
    );
    expect(
      nacl.sign.detached.verify(
        bytes,
        new Uint8Array(sig),
        receiptKeyPair.publicKey,
      ),
    ).toBe(true);
    for (const value of [
      text + '\nextra',
      text.replace('http://localhost', 'https://other.test'),
      text.replace('Solana devnet', 'Solana mainnet'),
      'arbitrary signing request',
    ])
      expect(() =>
        inspectVaultDevnetOwnership(
          new TextEncoder().encode(value),
          receiptWallet,
          'http://localhost',
          now,
        ),
      ).toThrow();
    expect(() =>
      inspectVaultDevnetOwnership(
        bytes,
        receiptWallet,
        'http://localhost',
        now + 300001,
      ),
    ).toThrow();
  });
  it('does not produce a signature after approval is invalidated or the key is absent', async () => {
    const { tx, op } = await fixture();
    await expect(
      signVaultDevnetTransaction(session, receiptWallet, tx, op, () => {
        throw new Error('Cancelled approval');
      }),
    ).rejects.toThrow('Cancelled');
    const empty = { ...session, payload: { version: 1 as const, wallets: [] } };
    await expect(
      signVaultDevnetTransaction(empty, receiptWallet, tx, op, () => {}),
    ).rejects.toThrow('not in the unlocked vault');
  });
});
