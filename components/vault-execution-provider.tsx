'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useClient } from '@solana/react';
import {
  address,
  getTransactionCodec,
  assertIsTransactionWithBlockhashLifetime,
  type Transaction,
  type TransactionPartialSigner,
  type SignatureBytes,
} from '@solana/kit';
import type { AppClient } from '@/lib/solana-client';
import {
  publicVaultWallets,
  unlockVault,
  VAULT_STORAGE_KEY,
  type VaultWallet,
} from '@/lib/browser-wallet-vault';
import {
  inspectVaultDevnetOwnership,
  inspectVaultDevnetTransaction,
  signVaultDevnetOwnership,
  signVaultDevnetTransaction,
  type VaultDevnetReview,
} from '@/lib/vault-devnet-signing';
import type { WalletOperation } from '@/lib/wallet-operation';
import { requireDevnet } from '@/lib/devnet-intent';
import { VaultApprovalCancelled } from '@/lib/wallet-signing-rejection';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';

type Connected = {
  account: { address: string };
  wallet: { name: string };
  signer: TransactionPartialSigner;
};
type ContextValue = {
  connected: Connected | null;
  open: () => void;
  disconnect: () => void;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
};
const Context = createContext<ContextValue | null>(null);
type Request = {
  wallet: string;
  epoch: number;
  message?: Uint8Array;
  transaction?: Transaction;
  operation?: WalletOperation;
  resolve: (signature: SignatureBytes) => void;
  reject: (error: Error) => void;
};
async function readPendingOperation(wallet: string) {
  const response = await fetch(
    `/api/wallet/operations?address=${encodeURIComponent(wallet)}`,
    { cache: 'no-store' },
  );
  const data = (await response.json()) as {
    active?: WalletOperation;
    error?: string;
  };
  if (!response.ok || !data.active)
    throw new Error(
      data.error || 'No pending operation is available for vault approval.',
    );
  return data.active;
}
export function VaultExecutionProvider({ children }: { children: ReactNode }) {
  const passphraseId = useId();
  const client = useClient<AppClient>();
  const [selected, setSelected] = useState<string | null>(null),
    [open, setOpen] = useState(false),
    [passphrase, setPassphrase] = useState(''),
    [choices, setChoices] = useState<VaultWallet[]>([]),
    [review, setReview] = useState<VaultDevnetReview | null>(null),
    [ownership, setOwnership] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [awaiting, setAwaiting] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0),
    selectedRef = useRef(selected),
    pending = useRef<Request | null>(null);
  const cancel = useCallback(() => {
    epoch.current++;
    const request = pending.current;
    pending.current = null;
    request?.reject(new VaultApprovalCancelled());
    setOpen(false);
    setPassphrase('');
    setChoices([]);
    setReview(null);
    setOwnership(null);
    setError('');
    setBusy(false);
    setAwaiting(false);
  }, []);
  const disconnect = useCallback(() => {
    cancel();
    selectedRef.current = null;
    setSelected(null);
  }, [cancel]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') disconnect();
    };
    const changed = (event: StorageEvent) => {
      if (event.key === VAULT_STORAGE_KEY || event.key === null) disconnect();
    };
    window.addEventListener('pagehide', disconnect);
    window.addEventListener('storage', changed);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      disconnect();
      window.removeEventListener('pagehide', disconnect);
      window.removeEventListener('storage', changed);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [disconnect]);
  const requestSignature = useCallback(
    (
      wallet: string,
      input: { message: Uint8Array } | { transaction: Transaction },
    ) =>
      new Promise<SignatureBytes>((resolve, reject) => {
        if (pending.current || selectedRef.current !== wallet) {
          reject(
            new Error(
              'Select this vault wallet before requesting one approval.',
            ),
          );
          return;
        }
        const current: Request = {
          wallet,
          epoch: epoch.current,
          resolve,
          reject,
          ...input,
        };
        pending.current = current;
        setAwaiting(true);
        const assertCurrent = () => {
          if (
            pending.current !== current ||
            current.epoch !== epoch.current ||
            selectedRef.current !== wallet
          )
            throw new Error('Vault approval changed.');
        };
        setBusy(true);
        setError('');
        setChoices([]);
        setReview(null);
        setOwnership(null);
        setPassphrase('');
        setOpen(true);
        void (async () => {
          try {
            if (current.transaction) {
              current.operation = await readPendingOperation(wallet);
              const value = await inspectVaultDevnetTransaction(
                current.transaction,
                current.operation,
                wallet,
              );
              assertCurrent();
              setReview(value);
            } else {
              const value = inspectVaultDevnetOwnership(
                current.message!,
                wallet,
                location.origin,
              );
              assertCurrent();
              setOwnership(value.message);
            }
            assertCurrent();
            setBusy(false);
          } catch (err) {
            if (pending.current === current) {
              pending.current = null;
              cancel();
              reject(
                err instanceof Error
                  ? err
                  : new Error('Vault approval unavailable.'),
              );
            }
          }
        })();
      }),
    [cancel],
  );
  const connected = useMemo<Connected | null>(
    () =>
      selected
        ? {
            account: { address: selected },
            wallet: { name: 'Browser vault · Devnet' },
            signer: {
              address: address(selected),
              signTransactions: async (transactions) => {
                if (transactions.length !== 1)
                  throw new Error('Approve exactly one vault transaction.');
                const input = transactions[0];
                assertIsTransactionWithBlockhashLifetime(input);
                const codec = getTransactionCodec(),
                  snapshot = {
                    ...codec.decode(codec.encode(input)),
                    lifetimeConstraint: { ...input.lifetimeConstraint },
                  };
                const signature = await requestSignature(selected, {
                  transaction: snapshot,
                });
                return [{ [selected]: signature }];
              },
            },
          }
        : null,
    [selected, requestSignature],
  );
  async function unlock() {
    if (busy || (pending.current && !review && !ownership)) return;
    const generation = epoch.current,
      password = passphrase;
    setPassphrase('');
    setBusy(true);
    setError('');
    let session: Awaited<ReturnType<typeof unlockVault>> | null = null;
    let expectedCiphertext: string | null = null;
    const assertCurrent = () => {
      if (generation !== epoch.current)
        throw new Error('Vault approval changed.');
      if (
        expectedCiphertext &&
        localStorage.getItem(VAULT_STORAGE_KEY) !== expectedCiphertext
      )
        throw new Error('Vault storage changed. Request a new approval.');
    };
    try {
      const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
      expectedCiphertext = encrypted;
      if (!encrypted)
        throw new Error(
          'Create or restore a browser vault in My wallets first.',
        );
      const request = pending.current;
      let active: WalletOperation | undefined;
      if (request && selectedRef.current !== request.wallet)
        throw new Error('Vault wallet changed.');
      if (request?.transaction) {
        active = await readPendingOperation(request.wallet);
        assertCurrent();
        if (active.id !== request.operation?.id)
          throw new Error('Pending operation changed.');
        await requireDevnet(client.rpc);
        assertCurrent();
        assertIsTransactionWithBlockhashLifetime(request.transaction);
        const valid = await client.rpc
          .isBlockhashValid(request.transaction.lifetimeConstraint.blockhash, {
            commitment: 'confirmed',
          })
          .send();
        assertCurrent();
        if (!valid.value)
          throw new Error(
            'The transaction blockhash expired. No vault signature was created.',
          );
      }
      session = await unlockVault(encrypted, password);
      assertCurrent();
      if (!request) {
        const wallets = publicVaultWallets(session).filter(
          (wallet) => wallet.family === 'solana',
        );
        if (!wallets.length)
          throw new Error(
            'No Solana keys exist in this vault. Generate or import one in My wallets.',
          );
        setChoices(wallets);
        return;
      }
      const signature = request.transaction
        ? await signVaultDevnetTransaction(
            session,
            request.wallet,
            request.transaction,
            active!,
            assertCurrent,
          )
        : signVaultDevnetOwnership(
            session,
            request.wallet,
            request.message!,
            location.origin,
            assertCurrent,
          );
      assertCurrent();
      if (localStorage.getItem(VAULT_STORAGE_KEY) !== encrypted)
        throw new Error('Vault storage changed. Request a new approval.');
      pending.current = null;
      request.resolve(signature);
      cancel();
    } catch (err) {
      if (generation === epoch.current)
        setError(err instanceof Error ? err.message : 'Vault approval failed.');
    } finally {
      if (session) session.payload.wallets = [];
      if (generation === epoch.current) setBusy(false);
    }
  }
  return (
    <Context.Provider
      value={{
        connected,
        disconnect,
        open: () => {
          cancel();
          setOpen(true);
        },
        signMessage: (message) =>
          selectedRef.current
            ? requestSignature(selectedRef.current, {
                message: new Uint8Array(message),
              })
            : Promise.reject(new Error('No browser vault wallet selected.')),
      }}
    >
      {children}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) cancel();
        }}
      >
        <DialogContent className="browser-vault-dialog">
          <DialogHeader>
            <DialogTitle>
              {review
                ? 'Approve vault devnet transaction'
                : ownership
                  ? 'Approve vault ownership message'
                  : 'Connect browser vault'}
            </DialogTitle>
            <DialogDescription>
              Private keys stay encrypted on this device. Enter your passphrase
              for this devnet approval. Mainnet warmup uses a separate
              transaction review.
            </DialogDescription>
          </DialogHeader>
          {review && (
            <div className="wallet-audit">
              <strong>
                {review.kind === 'memo'
                  ? 'Devnet memo. No SOL transfer.'
                  : `${review.amount} ${review.kind === 'sol' ? 'SOL' : 'tokens'} requested`}
              </strong>
              <p>Wallet: {review.wallet}</p>
              {review.mint && <p>Mint: {review.mint}</p>}
              {review.recipient && <p>Recipient: {review.recipient}</p>}
              <p>
                Network fee upper estimate: {review.maximumNetworkFeeLamports}{' '}
                lamports.
              </p>
              {review.createsAccount && (
                <p>
                  An associated token account may be created. Rent can also be
                  charged. Review the prepared transfer before approving.
                </p>
              )}
              <small>Reservation: {review.operationId}</small>
            </div>
          )}
          {ownership && (
            <pre className="vault-approval-message">{ownership}</pre>
          )}
          <p>
            Only the public wallet selection remains connected. Every message or
            transaction needs a separate approval. Hiding this tab disconnects
            the vault.
          </p>
          {error && <p role="alert">{error}</p>}
          {choices.length ? (
            <div className="wallet-audit">
              {choices.map((wallet) => (
                <Button
                  variant="outline"
                  key={wallet.id}
                  disabled={busy}
                  onClick={async () => {
                    const generation = epoch.current;
                    setBusy(true);
                    try {
                      await client.wallet.disconnect();
                      if (generation !== epoch.current) return;
                      setSelected(wallet.address);
                      selectedRef.current = wallet.address;
                      cancel();
                    } catch {
                      if (generation === epoch.current) {
                        setError('External wallet could not disconnect.');
                        setBusy(false);
                      }
                    }
                  }}
                >
                  {wallet.address}
                </Button>
              ))}
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void unlock();
              }}
            >
              <label htmlFor={passphraseId}>
                Vault passphrase
                <Input
                  id={passphraseId}
                  type="password"
                  autoComplete="off"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  disabled={busy}
                  required
                />
              </label>
              <Button
                type="submit"
                disabled={busy || (awaiting && !review && !ownership)}
              >
                {busy
                  ? 'Checking vault…'
                  : review || ownership
                    ? 'Approve and sign locally'
                    : 'Unlock to choose wallet'}
              </Button>
            </form>
          )}
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
    </Context.Provider>
  );
}
export function useVaultExecution() {
  const context = useContext(Context);
  if (!context) throw new Error('Vault execution provider is missing.');
  return context;
}
export function VaultExecutionConnect() {
  const context = useVaultExecution();
  return (
    <Button variant="outline" onClick={context.open}>
      Use browser vault
    </Button>
  );
}
