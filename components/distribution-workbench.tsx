'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { address } from '@solana/kit';
import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useSignMessage,
  useWalletStatus,
  useWallets,
} from '@solana/kit-plugin-wallet/react';
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileSignature,
  FileWarning,
  Layers3,
  LockKeyhole,
  RefreshCw,
  Shield,
  Users,
  WalletCards,
  Boxes,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAppClient } from '@/components/solana-provider';
import {
  buildDistributionPlan,
  formatDistributionAmount,
  sumDistributionAmounts,
  toBaseUnits,
  type DistributionPlan,
} from '@/lib/distribution-plan';
import {
  DEVNET_PREFLIGHT_LIFETIME_MS,
  isCurrentPreflight,
  requireDevnet,
  type DevnetPreflight,
} from '@/lib/devnet-intent';
import { useDevnetIntent } from '@/components/use-devnet-intent';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import {
  readDistributionReceipts,
  remainingDistributionRecipients,
  type DistributionReceipt,
} from '@/lib/distribution-receipts';
import {
  distributionAuditKey,
  validateDistributionClaim,
  type DistributionClaim,
} from '@/lib/distribution-audit';
import { useWalletAudit } from '@/components/use-wallet-audit';
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

const EMPTY_MANIFEST = `# Paste real Solana devnet recipients below.
# address, amount, optional label`;

function DistributionExecution({
  plan,
  reviewKey,
}: {
  plan: DistributionPlan | null;
  reviewKey: string;
}) {
  const mintInputId = useId();
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
  const [mintAddress, setMintAddress] = useState('');
  const [decimals, setDecimals] = useState<number | null>(null);
  const [sourceBalance, setSourceBalance] = useState<bigint | null>(null);
  const [preflight, setPreflight] = useState<DevnetPreflight | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState(
    'Connect a devnet wallet and enter its SPL token mint.',
  );
  const [localReceipts, setLocalReceipts] = useState<DistributionReceipt[]>([]);
  const [localReadKey, setLocalReadKey] = useState<string | null>(null);
  const [auditIdentity, setAuditIdentity] = useState<{
    identity: string;
    key: string;
    claim: DistributionClaim;
  } | null>(null);
  const [identityError, setIdentityError] = useState('');
  const [ownership, setOwnership] = useState<{
    wallet: string;
    revision: number;
    expiresAt: number;
  } | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const walletAddress = connected?.account.address ?? null;
  const operations = useWalletOperations(walletAddress);
  const planIdentity =
    plan?.recipients
      .map((recipient) => `${recipient.address}:${recipient.amount}`)
      .join('|') ?? '';
  const executionKey =
    walletAddress && mintAddress && planIdentity
      ? `pulseforge:distro:${walletAddress}:${mintAddress}:${planIdentity}`
      : null;
  const reviewIdentity = executionKey ? `${executionKey}:${reviewKey}` : null;
  const scope = useDevnetIntent(reviewIdentity);
  const walletScope = useDevnetIntent(walletAddress);
  const verified =
    !!ownership &&
    ownership.wallet === walletAddress &&
    walletScope.isCurrent(ownership.revision);
  const activeAudit =
    auditIdentity?.identity === reviewIdentity ? auditIdentity : null;
  const audit = useWalletAudit(
    activeAudit
      ? `address=${encodeURIComponent(activeAudit.claim.wallet)}&distributionKey=${activeAudit.key}`
      : null,
    0,
    true,
  );
  const audited = useMemo(() => {
    try {
      return {
        receipts: readDistributionReceipts(
          JSON.stringify(
            audit.events
              .filter((event) => event.eventType === 'token_transfer_finalized')
              .map((event) => {
                const details = JSON.parse(event.details) as {
                  recipient: string;
                  amount: string;
                  blockTime: number;
                  distributionKey: string;
                };
                if (details.distributionKey !== activeAudit?.key)
                  throw new Error('Distribution receipt identity mismatch.');
                return {
                  address: details.recipient,
                  amount: details.amount,
                  signature: event.transactionSignature,
                  confirmedAt: new Date(details.blockTime * 1000).toISOString(),
                };
              }),
          ),
        ),
        error: '',
      };
    } catch {
      return {
        receipts: [] as DistributionReceipt[],
        error:
          'Saved receipt evidence is invalid. Reload history before continuing.',
      };
    }
  }, [audit.events, activeAudit]);
  const receipts = audited.receipts;
  const pendingReceipt =
    localReadKey === executionKey
      ? localReceipts.find(
          (receipt) =>
            !receipts.some((row) => row.signature === receipt.signature) &&
            !audit.events.some(
              (event) =>
                event.eventType === 'token_transfer_failed' &&
                event.transactionSignature === receipt.signature,
            ),
        )
      : null;
  const historyReady =
    audit.ready && !audited.error && localReadKey === executionKey;
  const prepared = isCurrentPreflight(
    preflight,
    reviewIdentity,
    scope.capture(),
  );
  const remaining = remainingDistributionRecipients(
    plan?.recipients ?? [],
    receipts,
  );
  const pending = remaining[0] ?? null;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPreflight(null);
      setDecimals(null);
      setSourceBalance(null);
      setReceiptError(null);
      if (!executionKey) {
        setLocalReceipts([]);
        setLocalReadKey(null);
        return;
      }
      try {
        setLocalReceipts(
          readDistributionReceipts(window.localStorage.getItem(executionKey)),
        );
      } catch {
        setLocalReceipts([]);
        setReceiptError(
          'Local receipts are unavailable or invalid. Check your confirmed transfers before continuing.',
        );
      }
      setLocalReadKey(executionKey);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [executionKey]);

  useEffect(() => {
    const revision = scope.capture();
    if (reviewIdentity && walletAddress && plan)
      void (async () => {
        try {
          const claim = validateDistributionClaim({
            wallet: walletAddress,
            mint: mintAddress,
            recipients: plan.recipients,
          });
          const key = await distributionAuditKey(claim);
          if (scope.isCurrent(revision)) {
            setAuditIdentity({ identity: reviewIdentity, key, claim });
            setIdentityError('');
          }
        } catch (e) {
          if (scope.isCurrent(revision))
            setIdentityError(
              e instanceof Error ? e.message : 'Invalid distribution identity.',
            );
        }
      })();
  }, [reviewIdentity, walletAddress, mintAddress, plan, scope]);

  useEffect(() => {
    if (!ownership) return;
    const timer = window.setTimeout(
      () => {
        setOwnership(null);
        setPreflight(null);
      },
      Math.max(0, ownership.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [ownership]);

  async function verifyOwnership() {
    if (!walletAddress || working) return;
    const revision = walletScope.capture();
    setWorking(true);
    setPreflight(null);
    setMessage(
      'Verify this wallet for your signed-in account. This message authorizes no transfer.',
    );
    try {
      const expiresAt = await verifyConnectedWallet(
        walletAddress,
        (message) =>
          vault.connected
            ? vault.signMessage(message)
            : signMessageAction.dispatchAsync(message),
        () => walletScope.assertCurrent(revision),
      );
      setOwnership({ wallet: walletAddress, revision, expiresAt });
      setMessage(
        'Wallet verified for five minutes. Review the saved receipt history, then run preflight.',
      );
    } catch (e) {
      if (walletScope.isCurrent(revision))
        setMessage(
          e instanceof Error ? e.message : 'Wallet verification failed.',
        );
    } finally {
      setWorking(false);
    }
  }

  async function recordReceipt(
    receipt: DistributionReceipt,
    claim: DistributionClaim,
    revision: number,
    operationId?: string,
  ) {
    let recoveryOperationId = operationId;
    if (!recoveryOperationId && operations.active) {
      try {
        const intent = JSON.parse(operations.active.document) as {
          kind: string;
          distributionKey: string;
          recipient: string;
        };
        if (
          intent.kind === 'spl' &&
          intent.distributionKey === activeAudit?.key &&
          intent.recipient === receipt.address &&
          (!operations.active.signature ||
            operations.active.signature === receipt.signature)
        )
          recoveryOperationId = operations.active.id;
      } catch {
        /* The shared recovery panel can inspect an unsupported operation document. */
      }
    }
    const response = await fetch('/api/wallet/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: claim.wallet,
        signature: receipt.signature,
        distribution: claim,
        recipient: receipt.address,
        operationId: recoveryOperationId,
      }),
    });
    const data = (await response.json()) as {
      recorded?: boolean;
      outcome?: 'finalized' | 'failed';
      error?: string;
    };
    if (
      !response.ok ||
      !data.recorded ||
      !['finalized', 'failed'].includes(data.outcome || '')
    )
      throw new Error(data.error || 'Receipt verification is pending.');
    scope.assertCurrent(revision);
    setReceiptError((current) =>
      current?.startsWith(
        'Signed transaction captured, but local receipt storage failed.',
      )
        ? null
        : current,
    );
    audit.refresh();
    operations.refresh();
    setMessage(
      data.outcome === 'failed'
        ? 'Finalized failure saved. This recipient remains unpaid. Network fees may have been charged. Run a fresh preflight before retrying.'
        : 'Finalized transfer verified and saved to your account. Run preflight for the next recipient.',
    );
  }

  async function retryReceipt() {
    if (!pendingReceipt || !activeAudit || !verified || working) return;
    const revision = scope.capture();
    setWorking(true);
    setPreflight(null);
    setMessage('Verifying the existing transaction. No new transfer is sent.');
    try {
      await recordReceipt(pendingReceipt, activeAudit.claim, revision);
    } catch (e) {
      if (scope.isCurrent(revision))
        setMessage(
          e instanceof Error ? e.message : 'Receipt verification is pending.',
        );
    } finally {
      setWorking(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setPreflight(null), 0);
    return () => window.clearTimeout(timer);
  }, [reviewIdentity]);

  useEffect(() => {
    if (!preflight) return;
    const timer = window.setTimeout(
      () => {
        setPreflight(null);
        setMessage(
          'Preflight expired. Run it again before approving a transfer.',
        );
      },
      Math.max(0, preflight.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [preflight]);

  const prepare = async () => {
    if (
      !connected?.signer ||
      !mintAddress ||
      !plan ||
      !reviewIdentity ||
      !pending ||
      receiptError ||
      !verified ||
      !ownership ||
      ownership.expiresAt <= Date.now() ||
      !historyReady ||
      !operations.ready ||
      operations.active ||
      pendingReceipt ||
      working
    )
      return;
    const revision = scope.capture();
    setPreflight(null);
    setWorking(true);
    setMessage(
      'Reading the devnet mint and verifying the connected wallet balance…',
    );
    try {
      await requireDevnet(client.rpc);
      scope.assertCurrent(revision);
      const mint = await client.token.accounts.mint.fetch(address(mintAddress));
      const mintDecimals = mint.data.decimals;
      const [sourceAta] = await client.associatedToken.pdas.associatedToken({
        owner: address(walletAddress!),
        mint: mint.address,
        tokenProgram: mint.programAddress,
      });
      const source = await client.token.accounts.token.fetch(sourceAta);
      const required = remaining.reduce(
        (sum, recipient) => sum + toBaseUnits(recipient.amount, mintDecimals),
        0n,
      );
      if (source.data.mint !== mint.address)
        throw new Error(
          'Connected wallet token account does not match this mint.',
        );
      if (source.data.owner !== walletAddress || source.data.state !== 1)
        throw new Error(
          'Source token account must be initialized, unfrozen and owned by the connected wallet.',
        );
      if (source.data.amount < required)
        throw new Error(
          'Connected wallet does not hold enough tokens for this manifest.',
        );
      await client.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      scope.assertCurrent(revision);
      setDecimals(mintDecimals);
      setSourceBalance(source.data.amount);
      setPreflight({
        identity: reviewIdentity,
        revision,
        expiresAt: Date.now() + DEVNET_PREFLIGHT_LIFETIME_MS,
      });
      setMessage(
        `Preflight ready for 60 seconds · ${remaining.length} remaining recipients · wallet approval required for every transfer.`,
      );
    } catch (error) {
      if (scope.isCurrent(revision)) {
        setPreflight(null);
        setMessage(
          error instanceof Error ? error.message : 'Devnet preflight failed.',
        );
      }
    } finally {
      setWorking(false);
    }
  };

  const sendNext = async () => {
    if (
      !connected?.signer ||
      !pending ||
      decimals === null ||
      !isCurrentPreflight(preflight, reviewIdentity, scope.capture()) ||
      !plan ||
      receiptError ||
      !verified ||
      !ownership ||
      ownership.expiresAt <= Date.now() ||
      !historyReady ||
      !operations.ready ||
      operations.active ||
      pendingReceipt ||
      !activeAudit ||
      working
    )
      return;
    const signer = connected.signer;
    const revision = scope.capture();
    setWorking(true);
    setMessage(
      `Waiting for wallet approval to send ${formatDistributionAmount(pending.amount)} tokens…`,
    );
    try {
      await requireDevnet(client.rpc);
      scope.assertCurrent(revision);
      if (!isCurrentPreflight(preflight, reviewIdentity, revision))
        throw new Error('Preflight expired. Run it again.');
      setPreflight(null);
      assertRecoverableWalletSigner(signer);
      const submission = await runOwnedWalletOperation(
        {
          kind: 'spl',
          wallet: walletAddress!,
          distribution: activeAudit.claim,
          recipient: pending.address,
          distributionKey: activeAudit.key,
        },
        () => {
          scope.assertCurrent(revision);
          if (!isCurrentPreflight(preflight, reviewIdentity, revision))
            throw new Error('Preflight expired. Run it again.');
        },
        async (recordSignature) => {
          const submissionClient = createWalletSubmissionClient(
            client,
            signer,
            recordSignature,
            () => scope.assertCurrent(revision),
          );
          const result = await submissionClient.token.instructions
            .transferToATA({
              payer: submissionClient.payer,
              mint: address(mintAddress),
              recipient: address(pending.address),
              authority: submissionClient.payer,
              amount: toBaseUnits(pending.amount, decimals),
              decimals,
            })
            .sendTransaction();
          return result.context.signature;
        },
        (signature) => {
          const receipt = {
            address: pending.address,
            amount: pending.amount,
            signature,
            confirmedAt: new Date().toISOString(),
          };
          // A wallet prompt may finish after an edit. Preserve its receipt under the original manifest.
          if (executionKey) {
            try {
              const previous = readDistributionReceipts(
                window.localStorage.getItem(executionKey),
              );
              window.localStorage.setItem(
                executionKey,
                JSON.stringify([...previous, receipt]),
              );
            } catch {
              if (scope.isCurrent(revision)) {
                setLocalReceipts((current) => [...current, receipt]);
                setReceiptError(
                  'Signed transaction captured, but local receipt storage failed. Verify the existing transaction before continuing.',
                );
              }
              throw new Error(
                'Signed transaction captured, but local receipt storage failed.',
              );
            }
          }
          if (scope.isCurrent(revision))
            setLocalReceipts((current) => [...current, receipt]);
        },
      );
      scope.assertCurrent(revision);
      await recordReceipt(
        {
          address: pending.address,
          amount: pending.amount,
          signature: submission.signature,
          confirmedAt: new Date().toISOString(),
        },
        activeAudit.claim,
        revision,
        submission.id,
      );
    } catch (error) {
      if (scope.isCurrent(revision))
        setMessage(
          error instanceof Error
            ? error.message
            : 'Transfer was rejected or failed.',
        );
    } finally {
      operations.refresh();
      setWorking(false);
    }
  };

  return (
    <section className="execution-console">
      <header>
        <span>
          <WalletCards /> Devnet SPL execution
        </span>
        <b>WALLET APPROVAL · ONE TRANSFER AT A TIME</b>
      </header>
      <div className="execution-connect">
        <div className="kit-wallet-picker">
          {connected ? (
            <Button
              variant="outline"
              onClick={() =>
                vault.connected
                  ? vault.disconnect()
                  : void disconnectAction.dispatchAsync()
              }
            >
              Disconnect
            </Button>
          ) : (
            <Button
              onClick={() => setPickerOpen((open) => !open)}
              disabled={walletStatus === 'connecting'}
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
          <small>{connected?.wallet.name ?? 'No wallet connected'}</small>
          <strong>
            {walletAddress
              ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-6)}`
              : 'Solana devnet'}
          </strong>
        </span>
      </div>
      <label className="execution-mint" htmlFor={mintInputId}>
        <span>Devnet SPL token mint</span>
        <Input
          id={mintInputId}
          value={mintAddress}
          onChange={(event) => setMintAddress(event.target.value.trim())}
          placeholder="Enter mint address"
        />
      </label>
      <div className="execution-status">
        <span>
          <small>Mint decimals</small>
          <strong>{decimals ?? '—'}</strong>
        </span>
        <span>
          <small>Source balance</small>
          <strong>
            {sourceBalance === null || decimals === null
              ? '—'
              : formatDistributionAmount(
                  formatNativeBalance(sourceBalance.toString(), decimals),
                )}
          </strong>
        </span>
        <span>
          <small>Confirmed</small>
          <strong>
            {receipts.length} / {plan?.recipients.length ?? 0}
          </strong>
        </span>
      </div>
      <p className="execution-message">{message}</p>
      {
        <WalletOperationPanel
          available={!!walletAddress}
          key={operations.active?.id || walletAddress || 'disconnected'}
          {...operations}
          verified={verified}
          onResolved={(_signature, outcome) => {
            audit.refresh();
            setPreflight(null);
            setMessage(
              outcome === 'failed'
                ? 'Finalized failure verified. The recipient remains unpaid. Run a fresh preflight before retrying.'
                : 'Existing transfer verified. Run a fresh preflight to continue.',
            );
            setReceiptError((current) =>
              current?.startsWith(
                'Signed transaction captured, but local receipt storage failed.',
              )
                ? null
                : current,
            );
          }}
        />
      }
      {(audit.error || audited.error || identityError) && (
        <p role="alert" className="execution-message">
          {audit.error || audited.error || identityError}
        </p>
      )}
      {activeAudit && (
        <p className="execution-message">
          {audit.loading
            ? 'Loading account receipt history…'
            : `${receipts.length} finalized receipts saved for this distribution.`}{' '}
          <Button
            variant="ghost"
            disabled={working || audit.loading}
            onClick={audit.refresh}
          >
            Reload receipts
          </Button>
        </p>
      )}
      <div className="execution-actions">
        <Button
          variant="outline"
          disabled={!connected?.signer || working}
          onClick={() => void verifyOwnership()}
        >
          <FileSignature />{' '}
          {verified ? 'Verify ownership again' : 'Verify ownership'}
        </Button>
        {pendingReceipt && (
          <Button
            disabled={!verified || working}
            onClick={() => void retryReceipt()}
          >
            Verify pending receipt
          </Button>
        )}
      </div>
      {pendingReceipt && (
        <p className="execution-message">
          A transaction is pending receipt verification. Approving another
          transfer is blocked until it is verified.
        </p>
      )}
      {receiptError && (
        <p role="alert" className="execution-message">
          {receiptError}
        </p>
      )}
      <div className="execution-actions">
        <Button
          variant="outline"
          onClick={() => void prepare()}
          disabled={
            !connected?.signer ||
            !mintAddress ||
            !pending ||
            working ||
            !verified ||
            !historyReady ||
            !operations.ready ||
            !!operations.active ||
            !!pendingReceipt ||
            !!receiptError
          }
        >
          <RefreshCw /> Run preflight
        </Button>
        <Button
          onClick={() => void sendNext()}
          disabled={
            !prepared ||
            !pending ||
            working ||
            !!receiptError ||
            !verified ||
            !historyReady ||
            !operations.ready ||
            !!operations.active ||
            !!pendingReceipt
          }
        >
          {pending || !plan ? (
            <>
              <FileSignature /> Approve next transfer
            </>
          ) : (
            <>
              <CheckCircle2 /> Distribution complete
            </>
          )}
        </Button>
      </div>
      {pending && prepared && (
        <div className="next-transfer">
          <span>
            <small>NEXT RECIPIENT</small>
            <strong>
              {pending.label ||
                `${pending.address.slice(0, 8)}…${pending.address.slice(-8)}`}
            </strong>
          </span>
          <b>{formatDistributionAmount(pending.amount)} tokens</b>
        </div>
      )}
      {receipts.length > 0 && (
        <div className="execution-receipts">
          <strong>Finalized account receipts</strong>
          {receipts
            .slice(-4)
            .reverse()
            .map((receipt) => (
              <a
                key={receipt.signature}
                href={`https://explorer.solana.com/tx/${receipt.signature}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
              >
                <span>
                  {receipt.address.slice(0, 6)}…{receipt.address.slice(-6)}
                </span>
                <b>{formatDistributionAmount(receipt.amount)}</b>
                <ExternalLink />
              </a>
            ))}
        </div>
      )}
      <small className="execution-boundary">
        <Shield /> Devnet identity is checked before approval. Preflight lasts
        60 seconds and applies to the reviewed wallet, mint and manifest. Each
        transfer needs a fresh preflight and wallet approval.
      </small>
    </section>
  );
}

export function DistributionWorkbench() {
  const inputId = useId();
  const [manifest, setManifest] = useState(EMPTY_MANIFEST);
  const [tokenSupply, setTokenSupply] = useState('1000000');
  const [reservePercent, setReservePercent] = useState('70');
  const [batchSize, setBatchSize] = useState(8);
  const result = useMemo(() => {
    try {
      return {
        plan: buildDistributionPlan({
          manifest,
          tokenSupply,
          reservePercent,
          batchSize,
        }),
        error: null,
      };
    } catch (error) {
      return {
        plan: null,
        error:
          error instanceof Error ? error.message : 'Invalid distribution plan.',
      };
    }
  }, [manifest, tokenSupply, reservePercent, batchSize]);

  const exportManifest = () => {
    if (!result.plan) return;
    const payload = {
      version: 2,
      amountEncoding: 'decimal-string',
      network: 'solana-devnet',
      execution: 'devnet-wallet-approved',
      createdAt: new Date().toISOString(),
      tokenSupply,
      reservePercent,
      totalAmount: result.plan.totalAmount,
      batches: result.plan.batches.map((recipients, index) => ({
        batch: index + 1,
        recipients,
      })),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `pulseforge-distribution-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="distribution-scroll">
      <header className="distribution-head">
        <div>
          <span className="eyebrow">
            <Boxes /> DISTRIBUTION / DEVNET WORKBENCH
          </span>
          <h1>Recipient Manifest</h1>
          <p>
            Turn a raw allocation list into validated, wallet-approved token
            delivery.
          </p>
        </div>
        <span className="read-only-badge">
          <LockKeyhole /> MAINNET LOCKED
        </span>
      </header>
      <div className="distribution-layout">
        <section className="distribution-editor">
          <div className="distribution-fields">
            <label htmlFor={`${inputId}-supply`}>
              <span>Token supply</span>
              <Input
                id={`${inputId}-supply`}
                inputMode="decimal"
                value={tokenSupply}
                onChange={(event) => setTokenSupply(event.target.value)}
              />
            </label>
            <label htmlFor={`${inputId}-reserve`}>
              <span>Protected reserve</span>
              <span className="number-wrap">
                <Input
                  id={`${inputId}-reserve`}
                  inputMode="decimal"
                  value={reservePercent}
                  onChange={(event) => setReservePercent(event.target.value)}
                />
                <b>%</b>
              </span>
            </label>
            <label htmlFor={`${inputId}-batch`}>
              <span>Recipients per review group</span>
              <Input
                id={`${inputId}-batch`}
                type="number"
                min={1}
                max={12}
                value={batchSize}
                onChange={(event) => setBatchSize(Number(event.target.value))}
              />
            </label>
          </div>
          <label className="manifest-field">
            <span>
              Recipient manifest <small>ADDRESS, AMOUNT, OPTIONAL LABEL</small>
            </span>
            <textarea
              value={manifest}
              onChange={(event) => setManifest(event.target.value)}
              spellCheck={false}
              aria-label="Recipient manifest"
            />
          </label>
          <div className={`manifest-state ${result.error ? 'error' : 'ready'}`}>
            {result.error ? (
              <>
                <FileWarning />{' '}
                <span>
                  <strong>Manifest blocked</strong>
                  <small>{result.error}</small>
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 />{' '}
                <span>
                  <strong>Manifest validated</strong>
                  <small>
                    Addresses, amounts, reserve, duplicates, and batch limits
                    passed.
                  </small>
                </span>
              </>
            )}
          </div>
          <div className="distribution-actions">
            <Button variant="outline" onClick={() => setManifest('')}>
              Clear manifest
            </Button>
            <Button onClick={exportManifest} disabled={!result.plan}>
              <Download /> Export audit manifest
            </Button>
          </div>
          <DistributionExecution
            plan={result.plan}
            reviewKey={JSON.stringify([
              manifest,
              tokenSupply,
              reservePercent,
              batchSize,
            ])}
          />
        </section>
        <aside className="distribution-review">
          <div className="distribution-kpis">
            <article>
              <Users />
              <span>
                <small>Recipients</small>
                <strong>{result.plan?.recipients.length ?? '—'}</strong>
              </span>
            </article>
            <article>
              <Layers3 />
              <span>
                <small>Review groups</small>
                <strong>{result.plan?.batches.length ?? '—'}</strong>
              </span>
            </article>
            <article>
              <Shield />
              <span>
                <small>Protected reserve</small>
                <strong>{reservePercent}%</strong>
              </span>
            </article>
          </div>
          <section className="allocation-card">
            <header>
              <span>Allocation review</span>
              <b>
                {result.plan
                  ? `${result.plan.allocationPercent.toFixed(2)}%`
                  : 'BLOCKED'}
              </b>
            </header>
            <div className="allocation-track">
              <i
                style={{
                  width: `${Math.min(100, result.plan?.allocationPercent ?? 0)}%`,
                }}
              />
            </div>
            <p>
              <span>Planned distribution</span>
              <b>
                {result.plan
                  ? formatDistributionAmount(result.plan.totalAmount)
                  : '—'}
              </b>
            </p>
            <p>
              <span>Maximum distributable</span>
              <b>
                {result.plan
                  ? formatDistributionAmount(result.plan.distributableAmount)
                  : '—'}
              </b>
            </p>
          </section>
          {result.plan?.warnings.length ? (
            <section className="distribution-warnings">
              <strong>Automatic corrections</strong>
              {result.plan.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </section>
          ) : null}
          <section className="batch-preview">
            <header>
              <span>Review-group preview</span>
              <b>MAX {Math.max(1, Math.min(12, batchSize))} RECIPIENTS</b>
            </header>
            {result.plan?.batches.slice(0, 4).map((batch, index) => (
              <div key={index}>
                <span>
                  <b>Group {String(index + 1).padStart(2, '0')}</b>
                  <small>
                    {batch.length} recipient{batch.length === 1 ? '' : 's'}
                  </small>
                </span>
                <em>
                  {formatDistributionAmount(
                    sumDistributionAmounts(
                      batch.map((recipient) => recipient.amount),
                    ),
                  )}{' '}
                  tokens
                </em>
              </div>
            ))}
            {result.plan && result.plan.batches.length > 4 && (
              <p>
                + {result.plan.batches.length - 4} more groups in the exported
                manifest
              </p>
            )}
          </section>
          <div className="distribution-boundary">
            <LockKeyhole />
            <p>
              <strong>Execution is approval-gated.</strong> Only the blue devnet
              console can move tokens, one confirmed wallet-approved transfer at
              a time. Exporting a manifest never sends funds.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
