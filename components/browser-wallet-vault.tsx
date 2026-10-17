'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LockKeyhole, Wallet as WalletIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  VAULT_STORAGE_KEY,
  createVault,
  encryptVault,
  unlockVault,
  publicVaultWallets,
  generateVaultWallets,
  importVaultWallets,
  exportVaultPrivateKeys,
  parseVaultEnvelope,
  saveBrowserVault,
  type VaultSession,
  type VaultWallet,
} from '@/lib/browser-wallet-vault';
import styles from './browser-wallet-vault.module.css';
import type { LaunchChain } from '@/lib/launch-plan';
import {
  validateOwnershipChallenge,
  type OwnershipChallenge,
} from '@/lib/wallet-ownership-message';
import { signVaultOwnership } from '@/lib/vault-ownership';

function download(text: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BrowserWalletVault({
  chain,
  onAddPublic,
  savedAddresses,
  verifiedAddresses,
  onVerified,
  onOpenWarmup,
}: {
  chain: LaunchChain;
  onAddPublic: (addresses: string[]) => Promise<boolean>;
  savedAddresses: string[];
  verifiedAddresses: string[];
  onVerified: () => Promise<void>;
  onOpenWarmup?: (address: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [guided, setGuided] = useState(false);
  const [created, setCreated] = useState<VaultWallet | null>(null);
  const [added, setAdded] = useState(false);
  const [exists, setExists] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [count, setCount] = useState('1');
  const [wallets, setWallets] = useState<VaultWallet[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [importing, setImporting] = useState(false);
  const privateInput = useRef<HTMLTextAreaElement>(null);
  const [verification, setVerification] = useState<{
    walletId: string;
    challenge: OwnershipChallenge;
  } | null>(null);
  const ownershipRequest = useRef<AbortController | null>(null);
  const session = useRef<VaultSession | null>(null);
  const persisted = useRef<string | null>(null);
  const epoch = useRef(0);
  const id = useId();
  const family = chain === 'Solana' ? 'solana' : 'evm';
  const lock = useCallback(() => {
    epoch.current++;
    ownershipRequest.current?.abort();
    setVerification(null);
    setCreated(null);
    setAdded(false);
    session.current = null;
    setUnlocked(false);
    setWallets([]);
    setSelected([]);
    setPassphrase('');
    setConfirm('');
    setExporting(false);
    setAcknowledged(false);
    setImporting(false);
    if (privateInput.current) privateInput.current.value = '';
  }, []);
  useEffect(() => {
    if (!open) return;
    try {
      persisted.current = localStorage.getItem(VAULT_STORAGE_KEY);
      setExists(persisted.current !== null);
    } catch {
      setError('Browser storage is unavailable.');
    }
    const changed = (event: StorageEvent) => {
      if (event.key === VAULT_STORAGE_KEY || event.key === null) {
        lock();
        persisted.current = null;
        setNotice('Browser storage changed. Reopen the vault.');
      }
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') lock();
    };
    window.addEventListener('storage', changed);
    window.addEventListener('pagehide', lock);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      lock();
      window.removeEventListener('storage', changed);
      window.removeEventListener('pagehide', lock);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [open, lock]);
  useEffect(() => {
    if (!unlocked) return;
    let timer = window.setTimeout(lock, 5 * 60_000);
    const active = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, 5 * 60_000);
    };
    document.addEventListener('pointerdown', active);
    document.addEventListener('keydown', active);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', active);
      document.removeEventListener('keydown', active);
    };
  }, [unlocked, lock]);
  async function operate(action: (current: () => boolean) => Promise<void>) {
    const generation = epoch.current;
    const current = () => epoch.current === generation;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action(current);
    } catch (e) {
      if (current())
        setError(e instanceof Error ? e.message : 'Vault operation failed.');
    } finally {
      setPassphrase('');
      setConfirm('');
      setBusy(false);
    }
  }
  const choices = wallets.filter((wallet) => wallet.family === family);
  async function ownershipPost(address: string, body: Record<string, unknown>) {
    const controller = new AbortController();
    ownershipRequest.current = controller;
    const response = await fetch('/api/wallet-workspace/ownership', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ chain, address, ...body }),
    });
    const value = await response.json();
    if (!response.ok) {
      const error =
        value && typeof value === 'object' && 'error' in value
          ? value.error
          : undefined;
      throw new Error(
        typeof error === 'string'
          ? error
          : 'Ownership verification unavailable.',
      );
    }
    return value;
  }
  async function importKeys(text: string, current: () => boolean) {
    if (!session.current || !current())
      throw new Error('Unlock the vault first.');
    const result = importVaultWallets(session.current, family, text);
    if (!result.added) {
      setNotice(`All ${result.skipped} keys are already in this vault.`);
      return;
    }
    const encrypted = await encryptVault(result.session);
    await saveBrowserVault(persisted.current, encrypted, current);
    if (!current()) return;
    persisted.current = encrypted;
    session.current = result.session;
    const publicWallets = publicVaultWallets(result.session);
    setWallets(publicWallets);
    setSelected(
      publicWallets
        .filter(
          (wallet) =>
            wallet.family === family && result.importedIds.includes(wallet.id),
        )
        .map((wallet) => wallet.id),
    );
    setImporting(false);
    setNotice(
      `${result.added} keys imported and encrypted locally. ${result.skipped} duplicates skipped. Download an updated backup.`,
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          if (!value) lock();
          setError('');
          setNotice('');
        }
      }}
    >
      <Button
        onClick={() => {
          setGuided(true);
          setOpen(true);
        }}
      >
        <WalletIcon /> Create wallet
      </Button>
      <DialogTrigger
        render={<Button variant="outline" onClick={() => setGuided(false)} />}
      >
        <LockKeyhole /> Browser vault
      </DialogTrigger>
      <DialogContent className="browser-vault-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {guided
              ? created
                ? 'Your wallet is ready'
                : `Create a ${chain === 'Solana' ? 'Solana' : 'EVM'} wallet`
              : 'Browser wallet vault'}
          </DialogTitle>
          <DialogDescription>
            {guided
              ? 'Your private key stays encrypted on this device. Only the public address is saved to your account.'
              : 'Manage the encrypted wallets saved in this browser.'}
          </DialogDescription>
        </DialogHeader>
        {guided && (
          <p className="browser-vault-scope">
            1. Protect your wallet · 2. Save a backup · 3. Open warmup
          </p>
        )}
        {!created && (
          <p className="browser-vault-scope">
            Keep your password and encrypted backup. We cannot reset it. This
            vault is shared across accounts on this browser and site. It locks
            when closed, hidden or idle for five minutes.
          </p>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {notice && <output>{notice}</output>}
        {guided && created ? (
          <div className={styles.created}>
            <strong>{chain} wallet</strong>
            <code className={styles.address}>{created.address}</code>
            <p>
              Your key is encrypted in this browser. Save a backup before
              continuing: clearing site data can erase it.
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                const stored = localStorage.getItem(VAULT_STORAGE_KEY);
                if (!stored || stored !== persisted.current) {
                  setError(
                    'Vault changed. Reopen it before downloading a backup.',
                  );
                  return;
                }
                parseVaultEnvelope(stored);
                download(stored, 'bundle-encrypted-vault.json');
                setNotice(
                  'Encrypted backup downloaded. Keep it with your password in a safe place.',
                );
              }}
            >
              Download encrypted backup
            </Button>
            {!added ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void operate(async (current) => {
                    const saved = await onAddPublic([created.address]);
                    if (!current()) return;
                    if (!saved)
                      throw new Error(
                        'Your encrypted wallet is safe. Try saving its public address again.',
                      );
                    setAdded(true);
                  })
                }
              >
                {busy ? 'Saving address…' : 'Retry saving public address'}
              </Button>
            ) : (
              <Button
                onClick={() => {
                  const address = created.address;
                  lock();
                  setOpen(false);
                  if (chain === 'Solana') onOpenWarmup?.(address);
                }}
              >
                {chain === 'Solana' && onOpenWarmup
                  ? 'Continue to warmup'
                  : 'Done'}
              </Button>
            )}
          </div>
        ) : !unlocked ? (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void operate(async (current) => {
                  const stored = localStorage.getItem(VAULT_STORAGE_KEY);
                  if (exists && stored === null)
                    throw new Error(
                      'Vault storage changed. Close and reopen the vault.',
                    );
                  if (!exists && stored !== null)
                    throw new Error(
                      'A vault already exists. Reopen to unlock it.',
                    );
                  if (!exists && passphrase !== confirm)
                    throw new Error('Passwords do not match.');
                  let next =
                    stored === null
                      ? await createVault(passphrase)
                      : await unlockVault(stored, passphrase);
                  if (!current()) return;
                  if (guided) next = generateVaultWallets(next, family, 1);
                  let encrypted = stored;
                  if (stored === null || guided) {
                    encrypted = await encryptVault(next);
                    await saveBrowserVault(stored, encrypted, current);
                  }
                  if (
                    !current() ||
                    localStorage.getItem(VAULT_STORAGE_KEY) !== encrypted
                  )
                    throw new Error('Vault changed. Reopen and unlock again.');
                  persisted.current = encrypted;
                  session.current = next;
                  setExists(true);
                  setUnlocked(true);
                  const publicWallets = publicVaultWallets(next);
                  setWallets(publicWallets);
                  if (guided) {
                    const wallet = publicWallets[publicWallets.length - 1];
                    setCreated(wallet);
                    const saved = await onAddPublic([wallet.address]);
                    if (!current()) return;
                    setAdded(saved);
                    if (!saved)
                      throw new Error(
                        'Your encrypted wallet is safe. Try saving its public address again.',
                      );
                  }
                });
              }}
            >
              <label htmlFor={`${id}-password`}>Wallet password</label>
              <Input
                id={`${id}-password`}
                type="password"
                autoComplete={exists ? 'current-password' : 'new-password'}
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                disabled={busy}
                required
              />
              {!exists && (
                <>
                  <small>
                    Use a unique password with at least 12 characters.
                  </small>
                  <label htmlFor={`${id}-confirm`}>Confirm password</label>
                  <Input
                    id={`${id}-confirm`}
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    disabled={busy}
                    required
                  />
                </>
              )}
              <Button type="submit" disabled={busy}>
                {busy
                  ? guided
                    ? 'Creating wallet...'
                    : 'Opening vault...'
                  : guided
                    ? exists
                      ? 'Unlock and create wallet'
                      : 'Create wallet'
                    : exists
                      ? 'Unlock vault'
                      : 'Create encrypted vault'}
              </Button>
            </form>
            {!exists && (
              <details>
                <summary>Restore a backup instead</summary>
                <label
                  className="browser-vault-restore"
                  htmlFor={`${id}-restore`}
                >
                  Restore an encrypted backup
                  <Input
                    id={`${id}-restore`}
                    type="file"
                    accept=".json,application/json"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (!file) return;
                      void operate(async (current) => {
                        if (file.size > 300_000)
                          throw new Error('Vault backup is too large.');
                        const text = await file.text();
                        parseVaultEnvelope(text);
                        const restored = await unlockVault(text, passphrase);
                        if (!current()) return;
                        await saveBrowserVault(null, text, current);
                        if (!current()) return;
                        persisted.current = text;
                        session.current = restored;
                        setExists(true);
                        setUnlocked(true);
                        setWallets(publicVaultWallets(restored));
                        setGuided(false);
                        setNotice('Encrypted backup restored.');
                      });
                    }}
                  />
                  <small>
                    Enter the backup password above before selecting its file.
                    Restoring never replaces an existing vault.
                  </small>
                </label>
              </details>
            )}
          </>
        ) : (
          <>
            <div className="browser-vault-status">
              <strong>{wallets.length} saved keys · Unlocked</strong>
              <Button variant="outline" disabled={busy} onClick={lock}>
                Lock vault
              </Button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void operate(async (current) => {
                  if (!session.current)
                    throw new Error('Unlock the vault first.');
                  const next = generateVaultWallets(
                    session.current,
                    family,
                    Number(count),
                  );
                  const encrypted = await encryptVault(next);
                  await saveBrowserVault(persisted.current, encrypted, current);
                  if (!current()) return;
                  persisted.current = encrypted;
                  session.current = next;
                  const publicWallets = publicVaultWallets(next);
                  setWallets(publicWallets);
                  setSelected(
                    publicWallets
                      .slice(-Number(count))
                      .map((wallet) => wallet.id),
                  );
                  setNotice(
                    'Wallets generated and encrypted locally. Download an updated backup.',
                  );
                });
              }}
            >
              <label htmlFor={`${id}-count`}>
                Generate {chain === 'Solana' ? 'Solana' : 'EVM'} wallets
              </label>
              <div className="browser-vault-generate">
                <Input
                  id={`${id}-count`}
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                  disabled={busy}
                />
                <Button type="submit" disabled={busy}>
                  Generate wallets
                </Button>
              </div>
            </form>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setImporting(!importing);
                setExporting(false);
                if (privateInput.current) privateInput.current.value = '';
                setError('');
              }}
            >
              Import private keys…
            </Button>
            {importing && (
              <form
                className="browser-vault-import"
                onSubmit={(event) => {
                  event.preventDefault();
                  const text = privateInput.current?.value ?? '';
                  if (privateInput.current) privateInput.current.value = '';
                  void operate((current) => importKeys(text, current));
                }}
              >
                <label htmlFor={`${id}-private`}>
                  {family === 'solana'
                    ? 'Solana private keys, one per line'
                    : 'EVM private keys, one per line'}
                </label>
                <textarea
                  ref={privateInput}
                  id={`${id}-private`}
                  rows={4}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy}
                  required
                  aria-describedby={`${id}-import-help`}
                />
                <small id={`${id}-import-help`}>
                  {family === 'solana'
                    ? 'Base58-encoded 64-byte keypairs, or a Solana JSON keypair.'
                    : '32-byte hexadecimal keys, with or without 0x.'}{' '}
                  Import up to 100 keys. A PulseForge private-key export can
                  include both wallet families. Keys are validated and encrypted
                  locally. Nothing is saved if any key is invalid.
                </small>
                <div className="browser-vault-export">
                  <Button type="submit" disabled={busy}>
                    Import and encrypt
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (privateInput.current) privateInput.current.value = '';
                      setImporting(false);
                    }}
                  >
                    Cancel import
                  </Button>
                </div>
                <label htmlFor={`${id}-private-file`}>
                  Or import a private-key file
                </label>
                <Input
                  id={`${id}-private-file`}
                  type="file"
                  accept=".json,.txt,text/plain,application/json"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    if (privateInput.current) privateInput.current.value = '';
                    void operate(async (current) => {
                      if (file.size > 100_000)
                        throw new Error('Private-key file exceeds 100 KB.');
                      const text = await file.text();
                      await importKeys(text, current);
                    });
                  }}
                />
                <small>
                  The selected file is read on this device. It is never
                  uploaded.
                </small>
              </form>
            )}
            <div className="browser-vault-list">
              {choices.length ? (
                choices.map((wallet) => (
                  <div key={wallet.id} className="browser-vault-wallet-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.includes(wallet.id)}
                        disabled={busy}
                        onChange={(event) =>
                          setSelected((previous) =>
                            event.target.checked
                              ? [...previous, wallet.id]
                              : previous.filter((value) => value !== wallet.id),
                          )
                        }
                      />
                      <code>{wallet.address}</code>
                    </label>
                    <div className="browser-vault-export">
                      <Button
                        variant="outline"
                        disabled={
                          busy || !savedAddresses.includes(wallet.address)
                        }
                        aria-label={`Prepare ownership message for ${wallet.address}`}
                        onClick={() =>
                          void operate(async (current) => {
                            setVerification(null);
                            const value = await ownershipPost(wallet.address, {
                              action: 'challenge',
                            });
                            if (!current()) return;
                            const challenge = validateOwnershipChallenge(
                              value,
                              window.location.origin,
                              chain,
                              wallet.address,
                            );
                            setVerification({ walletId: wallet.id, challenge });
                            setExporting(false);
                            setImporting(false);
                            if (privateInput.current)
                              privateInput.current.value = '';
                          })
                        }
                      >
                        {savedAddresses.includes(wallet.address)
                          ? 'Verify ownership'
                          : 'Add to roster to verify'}
                      </Button>
                      {verifiedAddresses.includes(wallet.address) && (
                        <small>Signature verified</small>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p>No {family === 'solana' ? 'Solana' : 'EVM'} keys yet.</p>
              )}
            </div>
            {verification && (
              <section
                className="browser-vault-ownership"
                aria-label="Review ownership message"
              >
                <h3>Review ownership message</h3>
                <p>
                  This records control of one saved address. It authorizes no
                  transaction and uses no gas. Only the public address and
                  signature go to this site.
                </p>
                <pre>{verification.challenge.message}</pre>
                <div className="browser-vault-export">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void operate(async (current) => {
                        if (
                          !session.current ||
                          localStorage.getItem(VAULT_STORAGE_KEY) !==
                            persisted.current
                        )
                          throw new Error(
                            'Vault changed. Lock and unlock again.',
                          );
                        const signature = await signVaultOwnership(
                          session.current,
                          verification.walletId,
                          chain,
                          verification.challenge,
                          window.location.origin,
                        );
                        if (!current()) return;
                        await ownershipPost(verification.challenge.address, {
                          action: 'verify',
                          id: verification.challenge.id,
                          signature,
                        });
                        if (!current()) return;
                        await onVerified();
                        if (current()) {
                          setVerification(null);
                          setNotice(
                            'Ownership signature verified. This historical proof does not approve a transaction.',
                          );
                        }
                      })
                    }
                  >
                    Sign ownership message and verify
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setVerification(null)}
                  >
                    Cancel verification
                  </Button>
                </div>
              </section>
            )}
            <Button
              variant="outline"
              disabled={busy || !selected.length || selected.length > 100}
              onClick={() =>
                void operate(async (current) => {
                  const addresses = choices
                    .filter((wallet) => selected.includes(wallet.id))
                    .map((wallet) => wallet.address);
                  if (!addresses.length || addresses.length > 100)
                    throw new Error('Select 1 to 100 public addresses.');
                  if (!(await onAddPublic(addresses)))
                    throw new Error(
                      'Could not add public addresses. Your encrypted keys are retained.',
                    );
                  if (current())
                    setNotice(
                      `Public addresses added to ${chain}. Keys stay in this browser.`,
                    );
                })
              }
            >
              Add selected public addresses to {chain}
            </Button>
            <small>
              {selected.length} selected. Add up to 100 public addresses per
              batch. EVM keys work across the EVM networks; adding addresses
              does not verify ownership.
            </small>
            <div className="browser-vault-export">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void operate(async () => {
                    const stored = localStorage.getItem(VAULT_STORAGE_KEY);
                    if (!stored)
                      throw new Error('No encrypted vault is available.');
                    parseVaultEnvelope(stored);
                    download(stored, 'pulseforge-encrypted-vault.json');
                  })
                }
              >
                Download encrypted backup
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setExporting(!exporting);
                  setImporting(false);
                  if (privateInput.current) privateInput.current.value = '';
                  setPassphrase('');
                  setAcknowledged(false);
                }}
              >
                Export private keys…
              </Button>
            </div>
            {exporting && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void operate(async (current) => {
                    if (!acknowledged)
                      throw new Error(
                        'Confirm the private-key export warning.',
                      );
                    const stored = localStorage.getItem(VAULT_STORAGE_KEY);
                    if (stored === null || stored !== persisted.current)
                      throw new Error('Vault changed. Lock and unlock again.');
                    const authenticated = await unlockVault(stored, passphrase);
                    if (
                      !current() ||
                      localStorage.getItem(VAULT_STORAGE_KEY) !== stored
                    )
                      return;
                    download(
                      exportVaultPrivateKeys(authenticated),
                      'pulseforge-private-keys.json',
                    );
                    setExporting(false);
                    setAcknowledged(false);
                    setNotice(
                      'Private keys exported to your download. Store this file privately.',
                    );
                  });
                }}
              >
                <p>
                  The downloaded file contains every private key in this vault,
                  across both wallet families, without encryption. Anyone with
                  it can control these wallets.
                </p>
                <label htmlFor={`${id}-export`}>Re-enter wallet password</label>
                <Input
                  id={`${id}-export`}
                  type="password"
                  autoComplete="current-password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  disabled={busy}
                  required
                />
                <label className="browser-vault-ack">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                    disabled={busy}
                  />
                  I understand this file contains unencrypted private keys.
                </label>
                <Button
                  type="submit"
                  disabled={busy || !acknowledged || !passphrase}
                >
                  Download private keys
                </Button>
              </form>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
