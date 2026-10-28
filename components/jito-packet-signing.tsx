'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { getWallets } from '@wallet-standard/app';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import { signApprovedWarmupPacket } from '@/lib/warmup-signing';
import {
  signApprovedExternalWarmupPacket,
  supportsWarmupExternalWallet,
  connectWarmupExternalWallet,
  type WarmupExternalWallet,
} from '@/lib/warmup-external-signer';
import { signNativeWithdrawal } from '@/lib/native-withdrawal';
import {
  signExternalNativeWithdrawal,
  supportsNativeWithdrawalWallet,
  connectNativeWithdrawalWallet,
} from '@/lib/native-withdrawal-external-signer';
import {
  requireJitoManifest,
  type JitoBundleManifest,
} from '@/lib/jito-bundle';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  createJitoPacketRecovery,
  readJitoPacketRecovery,
  JITO_RECOVERY_FILE_MAX_BYTES,
} from '@/lib/jito-packet-recovery';
import { WalletSigningRejected } from '@/lib/wallet-signing-rejection';
import type {
  JitoMemoryReservation,
  JitoMemorySignatureRecovery,
  JitoOperationToken,
} from '@/lib/jito-memory-signature-recovery';

export function JitoPacketSigning({
  manifest,
  packet,
  disabled,
  register,
  ownerScope,
  coordinator,
  isContextCurrent,
  beforeSign,
  beforeImport,
  recoveryDisabled,
}: {
  manifest: JitoBundleManifest;
  packet: number;
  disabled: boolean;
  register: (transaction: string, token?: JitoOperationToken) => Promise<void>;
  ownerScope: string;
  coordinator: JitoMemorySignatureRecovery;
  isContextCurrent: () => boolean;
  beforeSign: () => Promise<void>;
  beforeImport: () => Promise<void>;
  recoveryDisabled: boolean;
}) {
  const field = useId(),
    mounted = useRef(true),
    running = useRef(false);
  const [accepted, setAccepted] = useState(false),
    [password, setPassword] = useState(''),
    [choice, setChoice] = useState('vault'),
    [wallets, setWallets] = useState<WarmupExternalWallet[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState<string | null>(null);
  const swap = manifest.swaps[packet],
    wallet = swap?.wallet ?? manifest.tip.wallet;
  const label = swap ? `swap ${packet + 1}` : 'Jito tip';
  useEffect(() => {
    mounted.current = true;
    const registry = getWallets();
    const refresh = () =>
      setWallets(
        registry
          .get()
          .filter((w) =>
            swap
              ? supportsWarmupExternalWallet(w)
              : supportsNativeWithdrawalWallet(w),
          ),
      );
    refresh();
    const removeRegister = registry.on('register', refresh),
      removeUnregister = registry.on('unregister', refresh);
    return () => {
      mounted.current = false;
      removeRegister();
      removeUnregister();
    };
  }, [swap]);
  async function sign() {
    if (!accepted || disabled || running.current || pending) return;
    let operation: JitoOperationToken;
    try {
      if (
        !ownerScope ||
        Array.from({ length: manifest.swaps.length + 1 }, (_, index) =>
          coordinator.has(ownerScope, manifest.id, index),
        ).some(Boolean)
      )
        throw Error('A Jito signing outcome is still pending.');
      operation = coordinator.startOperation(ownerScope, manifest.id, packet);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Another Jito action is in progress.',
      );
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    const passphrase = password;
    setPassword('');
    const assertCurrent = () => {
      if (
        !mounted.current ||
        !isContextCurrent() ||
        Date.parse(manifest.expiresAt) <= Date.now()
      )
        throw new Error(
          'Bundle changed or expired. Keep any signature for recovery.',
        );
    };
    let reservation: JitoMemoryReservation | null = null;
    let started = false;
    try {
      await requireJitoManifest(manifest);
      assertCurrent();
      reservation = await coordinator.reserve(ownerScope, manifest, packet);
      assertCurrent();
      let transaction: string;
      const hooks = {
        beforeSign,
        onSignerStart: () => {
          assertCurrent();
          coordinator.markStarted(reservation!);
          started = true;
        },
        retainSigned: async (signed: { transaction: string }) => {
          await coordinator.capture(reservation!, manifest, signed.transaction);
        },
      };
      // Capture the verified output before the helper's final wallet check.
      // Registration must wait until that check has succeeded.
      const retainOnly = async (signed: { transaction: string }) => {
        await coordinator.capture(reservation!, manifest, signed.transaction);
      };
      if (choice === 'vault') {
        const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
        if (!encrypted)
          throw new Error(
            'Create or import this wallet in the encrypted browser vault first.',
          );
        let session = await unlockVault(encrypted, passphrase);
        try {
          assertCurrent();
          const signed = swap
            ? await signApprovedWarmupPacket(
                session,
                swap,
                assertCurrent,
                hooks,
              )
            : await signNativeWithdrawal(
                session,
                manifest.tip,
                assertCurrent,
                hooks,
              );
          transaction = signed.transaction;
        } finally {
          // Drop decrypted seeds as soon as this one explicit signing action ends.
          for (const item of session.payload.wallets) item.seed = '';
          session = null as unknown as typeof session;
        }
      } else {
        const external = wallets.find((w) => w.name === choice);
        if (!external)
          throw new Error('Selected external wallet is unavailable.');
        if (swap) {
          await connectWarmupExternalWallet(external, wallet);
          assertCurrent();
          transaction = (
            await signApprovedExternalWarmupPacket(
              external,
              swap,
              assertCurrent,
              retainOnly,
              hooks,
            )
          ).transaction;
        } else {
          await connectNativeWithdrawalWallet(external, wallet);
          assertCurrent();
          transaction = (
            await signExternalNativeWithdrawal(
              external,
              manifest.tip,
              assertCurrent,
              retainOnly,
              hooks,
            )
          ).transaction;
        }
      }
      if (
        !mounted.current ||
        !isContextCurrent() ||
        Date.parse(manifest.expiresAt) <= Date.now()
      )
        throw new Error(
          'Bundle context changed. Reload saved history to recover the signed packet.',
        );
      setPending(transaction);
      await register(transaction, operation);
      if (mounted.current) {
        setPending(null);
        setAccepted(false);
      }
    } catch (e) {
      if (reservation) {
        try {
          if (!started) coordinator.releaseUnstarted(reservation);
          else if (e instanceof WalletSigningRejected)
            coordinator.releaseRejected(reservation, e);
        } catch {
          // Keep any started or retained reservation for explicit recovery.
        }
      }
      if (mounted.current)
        setError(e instanceof Error ? e.message : 'Signing did not complete.');
    } finally {
      coordinator.finishOperation(operation);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function retryRegistration() {
    if (!pending || running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await register(pending);
      if (mounted.current) {
        setPending(null);
        setAccepted(false);
      }
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : 'Registration unavailable.');
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function exportRecovery() {
    if (!pending || running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const record = await createJitoPacketRecovery(manifest, packet, pending);
      if (!mounted.current) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(record, null, 2)], {
          type: 'application/json',
        }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `bundle-${manifest.id}-packet-${packet + 1}-recovery.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Recovery export unavailable.',
        );
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function importRecovery(file: File) {
    if (running.current || pending || recoveryDisabled || !ownerScope) return;
    let operation: JitoOperationToken;
    try {
      operation = coordinator.startOperation(ownerScope);
    } catch {
      setError('Another Jito action is in progress.');
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const assertCurrent = () => {
        if (!mounted.current || !isContextCurrent())
          throw new Error('Bundle context changed. Reload saved history.');
      };
      assertCurrent();
      if (file.size > JITO_RECOVERY_FILE_MAX_BYTES)
        throw new Error('Recovery file exceeds the packet limit.');
      const record = await readJitoPacketRecovery(
        await file.text(),
        manifest,
        packet,
      );
      assertCurrent();
      // Recheck the authenticated exact record after file and signature work.
      await beforeImport();
      assertCurrent();
      await coordinator.retainImported(
        ownerScope,
        manifest,
        packet,
        record.transaction,
        operation,
        assertCurrent,
      );
      if (mounted.current) {
        setAccepted(false);
        setPassword('');
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Recovery import unavailable.',
        );
    } finally {
      coordinator.finishOperation(operation);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p>
        Signer for {label}: <code>{wallet}</code>. This action signs one packet.
        It does not submit it.
      </p>
      <label htmlFor={`${field}-signer`}>Signing method for {label}</label>
      <select
        id={`${field}-signer`}
        value={choice}
        disabled={busy || Boolean(pending) || disabled}
        onChange={(e) => {
          setChoice(e.target.value);
          setAccepted(false);
        }}
      >
        <option value="vault">Encrypted browser vault</option>
        {wallets.map((w) => (
          <option key={w.name} value={w.name}>
            {w.name}
          </option>
        ))}
      </select>
      {choice === 'vault' && (
        <>
          <label htmlFor={`${field}-password`}>
            Vault password for {label}
          </label>
          <Input
            id={`${field}-password`}
            type="password"
            autoComplete="off"
            value={password}
            disabled={busy || disabled || Boolean(pending)}
            onChange={(e) => setPassword(e.target.value)}
          />
        </>
      )}
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={accepted}
          disabled={busy || disabled || Boolean(pending)}
          onChange={(e) => setAccepted(e.target.checked)}
        />
        <span className="min-w-0 flex-1 break-words">
          I approve signing {label} in bundle {manifest.id}, with the displayed
          order, amounts and tip.
        </span>
      </label>
      <Button
        disabled={
          disabled ||
          busy ||
          !accepted ||
          Boolean(pending) ||
          (choice === 'vault' && !password)
        }
        onClick={() => void sign()}
      >
        Sign {label} only
      </Button>
      {pending && (
        <>
          <label htmlFor={`${field}-retained`}>
            Retained signed {label} packet
          </label>
          <textarea
            id={`${field}-retained`}
            readOnly
            spellCheck={false}
            rows={3}
            value={pending}
            className="w-full break-all rounded-md border p-2 font-mono text-xs"
          />
          <p>
            Registration has not completed. Keep this exact packet for recovery
            before leaving this page. It is a signed transaction; sharing it can
            allow submission. Retrying registration does not sign or submit.
          </p>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => void exportRecovery()}
          >
            Download signed packet recovery file
          </Button>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => void retryRegistration()}
          >
            Retry signature registration only
          </Button>
        </>
      )}
      {!pending && (
        <details>
          <summary>Recover an already signed {label} packet</summary>
          <p>
            Import the recovery file for this exact bundle and packet. Import
            verifies it locally and does not sign, register or submit. Then
            choose registration only after a separate approval. Keep recovery
            files private because they contain signed transactions.
          </p>
          <label htmlFor={`${field}-recovery`}>
            Signed packet recovery file
          </label>
          <input
            id={`${field}-recovery`}
            type="file"
            accept="application/json,.json"
            disabled={busy || recoveryDisabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importRecovery(file);
            }}
          />
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
