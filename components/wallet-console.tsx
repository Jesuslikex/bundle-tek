'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { address } from '@solana/kit';
import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useSignMessage,
  useWalletStatus,
  useWallets,
} from '@solana/kit-plugin-wallet/react';
import bs58 from 'bs58';
import {
  CheckCircle2,
  ExternalLink,
  FileSignature,
  RefreshCw,
  Shield,
  WalletCards,
} from 'lucide-react';
import { useAppClient } from '@/components/solana-provider';
import { Button } from '@/components/ui/button';
import { lamportsToSolNumber } from '@/lib/solana-format';
import {
  DEVNET_PREFLIGHT_LIFETIME_MS,
  isCurrentPreflight,
  requireDevnet,
  type DevnetPreflight,
} from '@/lib/devnet-intent';
import { useDevnetIntent } from '@/components/use-devnet-intent';
import { verifyConnectedWallet } from '@/lib/verify-connected-wallet';
import { runOwnedWalletOperation } from '@/lib/wallet-operation-client';
import { assertRecoverableWalletSigner } from '@/lib/recoverable-wallet-signer';
import { createWalletSubmissionClient } from '@/lib/wallet-submission-client';
import { useWalletOperations } from '@/components/use-wallet-operations';
import { WalletOperationPanel } from '@/components/wallet-operation-panel';
import {
  useVaultExecution,
  VaultExecutionConnect,
} from '@/components/vault-execution-provider';

type ConsoleState = 'idle' | 'working' | 'ready' | 'error';
type AuditEvent = {
  id: string;
  eventType: string;
  transactionSignature?: string | null;
  createdAt: string;
};

export function WalletConsole() {
  const client = useAppClient();
  const wallets = useWallets(client);
  const external = useConnectedWallet(client);
  const vault = useVaultExecution();
  const connected = vault.connected || external;
  const walletStatus = useWalletStatus(client);
  const connectAction = useConnect(client);
  const disconnectAction = useDisconnect(client);
  const signMessageAction = useSignMessage(client);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [verifiedAddress, setVerifiedAddress] = useState<string | null>(null);
  const [verifiedUntil, setVerifiedUntil] = useState(0);
  const [preflight, setPreflight] = useState<DevnetPreflight | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [receiptRecorded, setReceiptRecorded] = useState(false);
  const [receiptFailed, setReceiptFailed] = useState(false);
  const [receiptStorageError, setReceiptStorageError] = useState(false);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [state, setState] = useState<ConsoleState>('idle');
  const [message, setMessage] = useState(
    'Connect a Wallet Standard wallet to begin.',
  );
  const walletAddress = connected?.account.address ?? null;
  const operations = useWalletOperations(walletAddress);
  const scope = useDevnetIntent(walletAddress);
  const verified = !!walletAddress && verifiedAddress === walletAddress;
  const pendingReceipt = !!signature && !receiptRecorded;
  const prepared = isCurrentPreflight(
    preflight,
    walletAddress,
    scope.capture(),
  );
  const shortAddress = useMemo(
    () =>
      walletAddress
        ? `${walletAddress.slice(0, 5)}…${walletAddress.slice(-5)}`
        : '—',
    [walletAddress],
  );

  const refreshAudit = useCallback(async () => {
    if (!walletAddress) return;
    const revision = scope.capture();
    const response = await fetch(
      `/api/wallet/events?address=${encodeURIComponent(walletAddress)}`,
      { cache: 'no-store' },
    );
    if (response.ok) {
      const result = (await response.json()) as { events: AuditEvent[] };
      if (scope.isCurrent(revision)) setEvents(result.events);
    }
  }, [walletAddress, scope]);

  const refreshBalance = useCallback(async () => {
    if (!walletAddress) return;
    const revision = scope.capture();
    try {
      await requireDevnet(client.rpc);
      if (!scope.isCurrent(revision)) return;
      const result = await client.rpc
        .getBalance(address(walletAddress), { commitment: 'confirmed' })
        .send();
      if (scope.isCurrent(revision))
        setBalance(lamportsToSolNumber(result.value));
    } catch (error) {
      if (scope.isCurrent(revision)) throw error;
    }
  }, [client, walletAddress, scope]);

  useEffect(() => {
    const revision = scope.capture();
    const timer = window.setTimeout(() => {
      setVerifiedAddress(null);
      setPreflight(null);
      setSignature(null);
      setReceiptRecorded(false);
      setReceiptFailed(false);
      setReceiptStorageError(false);
      setBalance(null);
      setEvents([]);
      setState('idle');
      if (!walletAddress) {
        setBalance(null);
        setEvents([]);
        setMessage('Connect a Wallet Standard wallet to begin.');
        return;
      }
      try {
        const stored = window.localStorage.getItem(
          `pulseforge:pending-memo:${walletAddress}`,
        );
        if (stored) {
          const saved = JSON.parse(stored) as unknown;
          if (
            typeof saved !== 'string' ||
            saved.length > 90 ||
            bs58.decode(saved).length !== 64
          )
            throw new Error('Invalid pending memo');
          setSignature(saved);
        }
      } catch {
        setReceiptStorageError(true);
      }
      setMessage(
        'Wallet connected on devnet. Verify ownership with a one-time server challenge.',
      );
      void Promise.all([refreshBalance(), refreshAudit()]).catch(() => {
        if (scope.isCurrent(revision))
          setMessage(
            'Wallet connected, but devnet data could not be fully loaded.',
          );
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [walletAddress, refreshBalance, refreshAudit, scope]);

  useEffect(() => {
    if (!verifiedUntil) return;
    const timer = window.setTimeout(
      () => {
        setVerifiedAddress(null);
        setPreflight(null);
      },
      Math.max(0, verifiedUntil - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [verifiedUntil]);

  useEffect(() => {
    if (!preflight) return;
    const timer = window.setTimeout(
      () => {
        setPreflight(null);
        setMessage('Preflight expired. Prepare the test again before signing.');
      },
      Math.max(0, preflight.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [preflight]);

  const verifyOwnership = async () => {
    if (!walletAddress || state === 'working') return;
    const revision = scope.capture();
    setPreflight(null);
    setState('working');
    setMessage('Creating a five-minute, single-use ownership challenge…');
    try {
      const expiresAt = await verifyConnectedWallet(
        walletAddress,
        (message) =>
          vault.connected
            ? vault.signMessage(message)
            : signMessageAction.dispatchAsync(message),
        () => scope.assertCurrent(revision),
      );
      setVerifiedAddress(walletAddress);
      setVerifiedUntil(expiresAt);
      setState('ready');
      setMessage('Ownership verified by the server for five minutes.');
      await refreshAudit();
    } catch (error) {
      if (scope.isCurrent(revision)) {
        setState('error');
        setMessage(
          error instanceof Error
            ? error.message
            : 'Signature request was rejected.',
        );
      }
    }
  };

  const prepare = async () => {
    if (
      !verified ||
      verifiedUntil <= Date.now() ||
      !walletAddress ||
      pendingReceipt ||
      !operations.ready ||
      operations.active ||
      receiptStorageError ||
      state === 'working'
    )
      return;
    const revision = scope.capture();
    setPreflight(null);
    setState('working');
    setMessage('Checking devnet health and preparing the memo instruction…');
    try {
      await requireDevnet(client.rpc);
      scope.assertCurrent(revision);
      await client.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      scope.assertCurrent(revision);
      setPreflight({
        identity: walletAddress,
        revision,
        expiresAt: Date.now() + DEVNET_PREFLIGHT_LIFETIME_MS,
      });
      setState('ready');
      setMessage(
        'Ready for 60 seconds. Devnet identity is checked again before wallet approval; your wallet shows the final fee.',
      );
    } catch (error) {
      if (scope.isCurrent(revision)) {
        setState('error');
        setMessage(
          error instanceof Error ? error.message : 'Devnet preparation failed.',
        );
      }
    }
  };

  const submit = async () => {
    if (
      !verified ||
      verifiedUntil <= Date.now() ||
      !isCurrentPreflight(preflight, walletAddress, scope.capture()) ||
      !connected?.signer ||
      pendingReceipt ||
      !operations.ready ||
      operations.active ||
      receiptStorageError ||
      state === 'working'
    )
      return;
    const signer = connected.signer;
    const revision = scope.capture();
    setState('working');
    setMessage(
      'Waiting for wallet approval. This submits only a devnet memo and network fee.',
    );
    try {
      await requireDevnet(client.rpc);
      scope.assertCurrent(revision);
      if (!isCurrentPreflight(preflight, walletAddress, revision))
        throw new Error('Preflight expired. Prepare the test again.');
      setPreflight(null);
      assertRecoverableWalletSigner(signer);
      const submission = await runOwnedWalletOperation(
        { kind: 'memo', wallet: walletAddress! },
        () => {
          scope.assertCurrent(revision);
          if (!isCurrentPreflight(preflight, walletAddress, revision))
            throw new Error('Preflight expired. Prepare again.');
        },
        async (recordSignature) => {
          const submissionClient = createWalletSubmissionClient(
            client,
            signer,
            recordSignature,
            () => scope.assertCurrent(revision),
          );
          const nextSignature = await submissionClient.memo.instructions
            .addMemo({
              memo: `PulseForge verified devnet wallet ${new Date().toISOString()}`,
              signers: [submissionClient.payer],
            })
            .sendTransaction();
          return nextSignature.context.signature;
        },
        (signatureText) => {
          try {
            window.localStorage.setItem(
              `pulseforge:pending-memo:${walletAddress}`,
              JSON.stringify(signatureText),
            );
          } catch {
            if (scope.isCurrent(revision)) setReceiptStorageError(true);
          }
          if (scope.isCurrent(revision)) {
            setSignature(signatureText);
            setReceiptRecorded(false);
            setReceiptFailed(false);
          }
        },
      );
      scope.assertCurrent(revision);
      await recordReceipt(submission.signature, revision, submission.id);
    } catch (error) {
      if (scope.isCurrent(revision)) {
        setState('error');
        setMessage(
          error instanceof Error
            ? error.message
            : 'Transaction was rejected or failed.',
        );
      }
    } finally {
      operations.refresh();
    }
  };

  async function recordReceipt(
    signatureText: string,
    revision: number,
    operationId?: string,
  ) {
    const auditResponse = await fetch('/api/wallet/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: walletAddress,
        signature: signatureText,
        operationId:
          operationId ||
          (operations.active?.kind === 'memo' &&
          (!operations.active.signature ||
            operations.active.signature === signatureText)
            ? operations.active.id
            : undefined),
      }),
    });
    const audit = (await auditResponse.json()) as {
      recorded?: boolean;
      outcome?: 'finalized' | 'failed';
      error?: string;
    };
    if (
      !auditResponse.ok ||
      !audit.recorded ||
      !['finalized', 'failed'].includes(audit.outcome || '')
    )
      throw new Error(
        audit.error ?? 'Transaction confirmed but audit recording failed',
      );
    scope.assertCurrent(revision);
    setReceiptRecorded(true);
    setReceiptFailed(audit.outcome === 'failed');
    operations.refresh();
    try {
      window.localStorage.removeItem(
        `pulseforge:pending-memo:${walletAddress}`,
      );
      setReceiptStorageError(false);
    } catch {
      setReceiptStorageError(true);
    }
    setState(audit.outcome === 'failed' ? 'error' : 'ready');
    setMessage(
      audit.outcome === 'failed'
        ? 'Finalized memo failure verified and saved. Network fees may have been charged. Prepare a fresh test before retrying.'
        : 'Finalized devnet memo verified and saved to your account.',
    );
    await Promise.all([refreshBalance(), refreshAudit()]);
  }

  async function retryReceipt() {
    if (!signature || !verified || state === 'working') return;
    const revision = scope.capture();
    setState('working');
    setPreflight(null);
    setMessage(
      'Verifying the existing transaction. No new transaction is sent.',
    );
    try {
      await recordReceipt(signature, revision);
    } catch (e) {
      if (scope.isCurrent(revision)) {
        setState('error');
        setMessage(
          e instanceof Error ? e.message : 'Receipt verification is pending.',
        );
      }
    }
  }

  return (
    <section className="wallet-console">
      <header>
        <span>
          <WalletCards /> Your wallet
        </span>
        <b>DEVNET</b>
      </header>
      <div className="wallet-next-step">
        <strong>
          {pendingReceipt
            ? 'Verify pending receipt'
            : signature && !prepared
              ? receiptFailed
                ? 'Test failed'
                : 'Test complete'
              : !connected
                ? '1. Connect your wallet'
                : !verified
                  ? '2. Verify ownership'
                  : !prepared
                    ? '3. Prepare the test'
                    : '4. Review and sign'}
        </strong>
        <p>
          {pendingReceipt
            ? 'Your existing transaction needs receipt verification before another test can be submitted.'
            : signature && !prepared
              ? receiptFailed
                ? 'The finalized failure is recorded. Prepare a fresh test before retrying.'
                : 'Your memo transaction is recorded. Open the receipt below to inspect it.'
              : !connected
                ? 'Select the wallet holding your devnet SOL.'
                : !verified
                  ? 'Sign a message to prove this wallet is yours. This step has no network fee.'
                  : !prepared
                    ? 'Check the devnet connection before requesting a transaction signature.'
                    : 'The test writes a memo and uses a small devnet network fee.'}
        </p>
      </div>
      <div className="wallet-connect-row">
        <div className="kit-wallet-picker">
          {connected ? (
            <Button
              onClick={() =>
                vault.connected
                  ? vault.disconnect()
                  : void disconnectAction.dispatchAsync()
              }
              disabled={disconnectAction.isRunning}
            >
              Disconnect
            </Button>
          ) : (
            <Button
              onClick={() => setPickerOpen((open) => !open)}
              disabled={
                walletStatus === 'pending' || walletStatus === 'connecting'
              }
            >
              {walletStatus === 'connecting' ? 'Connecting…' : 'Select wallet'}
            </Button>
          )}
          {pickerOpen && !connected && (
            <div className="kit-wallet-menu">
              {wallets.length ? (
                wallets.map((wallet) => (
                  <button
                    key={wallet.name}
                    onClick={() => {
                      setPickerOpen(false);
                      void connectAction.dispatchAsync(wallet);
                    }}
                  >
                    {wallet.name}
                  </button>
                ))
              ) : (
                <span>No compatible wallet extension detected.</span>
              )}
            </div>
          )}
        </div>
        {!connected && <VaultExecutionConnect />}
        <span>
          <small>{connected?.wallet.name ?? 'No wallet'}</small>
          <strong>{shortAddress}</strong>
        </span>
        <Button
          variant="outline"
          onClick={() =>
            void refreshBalance().catch(() => {
              setState('error');
              setMessage('Could not refresh the balance. Try again.');
            })
          }
          disabled={!connected || state === 'working'}
          aria-label="Refresh wallet balance"
        >
          <RefreshCw />
        </Button>
      </div>
      <div className="wallet-kpis">
        <span>
          <small>Network</small>
          <strong>Solana devnet</strong>
        </span>
        <span>
          <small>Balance</small>
          <strong>
            {balance === null ? '—' : `${balance.toFixed(4)} SOL`}
          </strong>
        </span>
        <span>
          <small>Ownership</small>
          <strong className={verified ? 'safe' : ''}>
            {verified ? 'SERVER VERIFIED' : 'UNVERIFIED'}
          </strong>
        </span>
      </div>
      <div className="wallet-actions">
        <Button
          variant="outline"
          onClick={() => void verifyOwnership()}
          disabled={!connected?.signer || state === 'working'}
        >
          <FileSignature /> Verify ownership
        </Button>
        <Button
          variant="outline"
          onClick={() => void prepare()}
          disabled={
            !verified ||
            pendingReceipt ||
            !operations.ready ||
            !!operations.active ||
            receiptStorageError ||
            state === 'working'
          }
        >
          <Shield /> Prepare preflight
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={
            !prepared ||
            !verified ||
            pendingReceipt ||
            !operations.ready ||
            !!operations.active ||
            receiptStorageError ||
            state === 'working'
          }
        >
          <CheckCircle2 /> Sign &amp; submit
        </Button>
      </div>
      {
        <WalletOperationPanel
          available={!!walletAddress}
          key={operations.active?.id || walletAddress || 'disconnected'}
          {...operations}
          verified={verified}
          onResolved={(signature, outcome) => {
            setSignature(signature);
            setReceiptRecorded(true);
            setReceiptFailed(outcome === 'failed');
            setPreflight(null);
            setState(outcome === 'failed' ? 'error' : 'ready');
            setMessage(
              outcome === 'failed'
                ? 'Finalized failure verified. Prepare a fresh test before retrying.'
                : 'Finalized memo verified and saved.',
            );
            try {
              window.localStorage.removeItem(
                `pulseforge:pending-memo:${walletAddress}`,
              );
              setReceiptStorageError(false);
            } catch {
              setReceiptStorageError(true);
            }
            void refreshAudit();
          }}
        />
      }
      {pendingReceipt && (
        <Button
          disabled={!verified || state === 'working'}
          onClick={() => void retryReceipt()}
        >
          Verify receipt
        </Button>
      )}
      {receiptStorageError && (
        <p role="alert">
          Local receipt storage is unavailable or invalid. Resolve the existing
          receipt before submitting another test.
        </p>
      )}
      {prepared && (
        <div className="wallet-review">
          <span>
            Instruction <b>Memo only</b>
          </span>
          <span>
            SOL transfer <b>0 SOL</b>
          </span>
          <span>
            Resource estimate <b>ENABLED</b>
          </span>
          <span>
            RPC preflight <b>ENABLED</b>
          </span>
        </div>
      )}
      <output aria-live="polite" className={`wallet-message ${state}`}>
        {message}
      </output>
      {signature && (
        <a
          className="wallet-explorer"
          href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
          target="_blank"
          rel="noreferrer"
        >
          {receiptFailed ? 'View failed transaction' : 'View transaction'}{' '}
          <ExternalLink />
        </a>
      )}
      {events.length > 0 && (
        <div className="wallet-audit">
          <strong>Persistent audit trail</strong>
          {events.slice(0, 3).map((event) => (
            <span key={event.id}>
              <b>{event.eventType.replaceAll('_', ' ')}</b>
              <small>{new Date(event.createdAt).toLocaleString()}</small>
            </span>
          ))}
        </div>
      )}
      <small className="wallet-boundary">
        Ownership challenges are single use and last five minutes. Preflight
        lasts 60 seconds and resets when the wallet changes. Keys stay in your
        wallet app.
      </small>
    </section>
  );
}
