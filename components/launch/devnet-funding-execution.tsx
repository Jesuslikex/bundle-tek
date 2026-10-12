'use client';
import { useCallback, useEffect, useState } from 'react';
import bs58 from 'bs58';
import { address } from '@solana/kit';
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { reviewDevnetTokenFunding } from '@/lib/devnet-token-funding';
import {
  useConnectedWallet,
  useSignMessage,
} from '@solana/kit-plugin-wallet/react';
import { useAppClient } from '@/components/solana-provider';
import {
  useVaultExecution,
  VaultExecutionConnect,
} from '@/components/vault-execution-provider';
import { Button } from '@/components/ui/button';
import { useDevnetIntent } from '@/components/use-devnet-intent';
import { useWalletOperations } from '@/components/use-wallet-operations';
import { WalletOperationPanel } from '@/components/wallet-operation-panel';
import {
  requireDevnet,
  DEVNET_PREFLIGHT_LIFETIME_MS,
} from '@/lib/devnet-intent';
import { verifyConnectedWallet } from '@/lib/verify-connected-wallet';
import { runOwnedWalletOperation } from '@/lib/wallet-operation-client';
import { operationDocument, UUID } from '@/lib/wallet-operation';
import { createWalletSubmissionClient } from '@/lib/wallet-submission-client';
import { assertRecoverableWalletSigner } from '@/lib/recoverable-wallet-signer';
import { toBaseUnits } from '@/lib/distribution-plan';
import { warmupDecimal } from '@/lib/wallet-warmup';
import type { FundingDocument } from '@/lib/funding-plan';
import { reviewDevnetNativeFunding } from '@/lib/devnet-native-funding';
import { simulateDevnetFunding } from '@/lib/devnet-funding-simulation';
type Review = {
  id: string;
  revision: number;
  network: 'devnet';
  document: FundingDocument;
  asset: { mint: string; decimals: number; symbol: string } | null;
  recipients: { address: string; amount: string; key: string }[];
  completed: string[];
};
type Prepared = {
  revision: number;
  expiresAt: number;
  key: string;
  required: string;
  balance: string;
  tokenBudget?: string;
  decimals?: number;
  simulation: { feeLamports: string; slot: string; unitsConsumed: string };
};
export function DevnetFundingExecution({
  id,
  revision,
  enabled,
  onReceiptChange,
}: {
  id: string;
  revision: number;
  enabled: boolean;
  onReceiptChange?: () => void;
}) {
  const client = useAppClient(),
    external = useConnectedWallet(client),
    vault = useVaultExecution(),
    connected = vault.connected || external,
    wallet = connected?.account.address.toString() || null,
    messageAction = useSignMessage(client),
    operations = useWalletOperations(wallet),
    scope = useDevnetIntent(JSON.stringify({ id, revision, enabled, wallet }));
  const [review, setReview] = useState<Review | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [verified, setVerified] = useState<{
      wallet: string;
      until: number;
    } | null>(null),
    [prepared, setPrepared] = useState<Prepared | null>(null),
    [reload, setReload] = useState(0),
    [pending, setPending] = useState<{ signature: string; id: string } | null>(
      null,
    ),
    [storageError, setStorageError] = useState(''),
    [notice, setNotice] = useState('');
  const matches =
    !!enabled && !!wallet && review?.document.funderAddress === wallet;
  const remaining =
      review?.recipients.filter((row) => !review.completed.includes(row.key)) ||
      [],
    next = remaining[0];
  const unit = review ? review.asset?.symbol || 'SOL' : 'saved asset';
  const owned = !!verified && verified.wallet === wallet;
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setBusy(false);
      setVerified(null);
      setPrepared(null);
      setNotice('');
      setPending(null);
      setStorageError('');
      if (!wallet) return;
      try {
        const stored = localStorage.getItem(
          `pulseforge:native-funding:${wallet}`,
        );
        if (!stored) {
          setPending(null);
          setStorageError('');
          return;
        }
        const value = JSON.parse(stored) as { id: string; signature: string };
        if (typeof value.id !== 'string' || !UUID.test(value.id))
          throw new Error('Invalid pending funding id.');
        if (
          typeof value.signature !== 'string' ||
          value.signature.length > 90 ||
          bs58.decode(value.signature).length !== 64
        )
          throw new Error('Invalid retained signature.');
        setPending(value);
        setStorageError('');
      } catch {
        setStorageError(
          'Pending funding storage could not be read. Resolve the existing operation before preparing another transfer.',
        );
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [wallet]);
  useEffect(() => {
    const controller = new AbortController(),
      version = scope.capture();
    void (async () => {
      try {
        const response = await fetch(
            `/api/funding/devnet?id=${encodeURIComponent(id)}&revision=${revision}`,
            { cache: 'no-store', signal: controller.signal },
          ),
          value = (await response.json()) as Review & { error?: string };
        if (
          !response.ok ||
          value.id !== id ||
          value.revision !== revision ||
          value.network !== 'devnet' ||
          !Array.isArray(value.recipients) ||
          !Array.isArray(value.completed)
        )
          throw new Error(value.error || 'Funding revision mismatch.');
        if (!controller.signal.aborted && scope.isCurrent(version)) {
          setReview(value);
          setError('');
          setLoading(false);
        }
      } catch (err) {
        if (!controller.signal.aborted && scope.isCurrent(version)) {
          setReview(null);
          setLoading(false);
          setError(
            err instanceof Error ? err.message : 'Funding review unavailable.',
          );
        }
      }
    })();
    return () => controller.abort();
  }, [id, revision, reload, scope, wallet, enabled]);
  useEffect(() => {
    if (!prepared) return;
    const timer = setTimeout(
      () => setPrepared(null),
      Math.max(0, prepared.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [prepared]);
  useEffect(() => {
    if (!verified) return;
    const timer = setTimeout(
      () => setVerified(null),
      Math.max(0, verified.until - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [verified]);
  async function verify() {
    if (!wallet || busy) return;
    const version = scope.capture();
    setBusy(true);
    setPrepared(null);
    setNotice('');
    try {
      const until = await verifyConnectedWallet(
        wallet,
        (message) =>
          vault.connected
            ? vault.signMessage(message)
            : messageAction.dispatchAsync(message),
        () => scope.assertCurrent(version),
      );
      scope.assertCurrent(version);
      setVerified({ wallet, until });
      setNotice('Funder ownership verified for five minutes.');
    } catch (err) {
      if (scope.isCurrent(version))
        setNotice(
          err instanceof Error ? err.message : 'Ownership request failed.',
        );
    } finally {
      if (scope.isCurrent(version)) setBusy(false);
    }
  }
  async function prepare() {
    if (
      !matches ||
      !owned ||
      (verified?.until || 0) <= Date.now() ||
      !connected ||
      !connected.signer ||
      !next ||
      pending ||
      storageError ||
      !operations.ready ||
      operations.active ||
      loading ||
      busy
    )
      return;
    const version = scope.capture(),
      startedAt = Date.now();
    let candidate: Omit<Prepared, 'simulation'> | null = null;
    let minimumSlot = 0n;
    setBusy(true);
    setPrepared(null);
    setNotice('');
    try {
      assertRecoverableWalletSigner(connected.signer);
      await requireDevnet(client.rpc);
      scope.assertCurrent(version);
      const check = await fetch(
          `/api/funding/devnet?id=${encodeURIComponent(id)}&revision=${revision}`,
          { cache: 'no-store' },
        ),
        latest = (await check.json()) as Review & { error?: string };
      scope.assertCurrent(version);
      if (
        !check.ok ||
        latest.id !== id ||
        latest.revision !== revision ||
        latest.network !== 'devnet' ||
        JSON.stringify(latest.document) !== JSON.stringify(review?.document) ||
        latest.completed.includes(next.key)
      )
        throw new Error(
          latest.error || 'Funding history changed. Refresh before preparing.',
        );
      if (latest.asset) {
        const asset = latest.asset;
        const [[source], [destination]] = await Promise.all([
          findAssociatedTokenPda({
            owner: address(wallet!),
            mint: address(asset.mint),
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          }),
          findAssociatedTokenPda({
            owner: address(next.address),
            mint: address(asset.mint),
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          }),
        ]);
        const [snapshot, balance, rent] = await Promise.all([
          client.rpc
            .getMultipleAccounts(
              [address(asset.mint), source, destination, address(wallet!)],
              { encoding: 'base64', commitment: 'confirmed' },
            )
            .send(),
          client.rpc
            .getBalance(address(wallet!), { commitment: 'confirmed' })
            .send(),
          client.rpc
            .getMinimumBalanceForRentExemption(165n, {
              commitment: 'confirmed',
            })
            .send(),
        ]);
        const budget = reviewDevnetTokenFunding({
          wallet: wallet!,
          mint: asset.mint,
          decimals: asset.decimals,
          remaining,
          accounts: snapshot.value,
          balance: balance.value,
          rent,
          slots: [snapshot.context.slot, balance.context.slot],
        });
        scope.assertCurrent(version);
        minimumSlot =
          snapshot.context.slot > balance.context.slot
            ? snapshot.context.slot
            : balance.context.slot;
        candidate = {
          revision: version,
          expiresAt: Date.now() + DEVNET_PREFLIGHT_LIFETIME_MS,
          key: next.key,
          required: warmupDecimal(budget.requiredSol, 9),
          balance: warmupDecimal(balance.value, 9),
          tokenBudget: `${warmupDecimal(budget.requiredTokens, asset.decimals)} / ${warmupDecimal(budget.tokenBalance, asset.decimals)} ${asset.symbol} required / available`,
          decimals: asset.decimals,
        };
      } else {
        const [balance, rent, recipient, funder] = await Promise.all([
          client.rpc
            .getBalance(address(wallet!), { commitment: 'confirmed' })
            .send(),
          client.rpc
            .getMinimumBalanceForRentExemption(0n, { commitment: 'confirmed' })
            .send(),
          client.rpc
            .getAccountInfo(address(next.address), {
              encoding: 'base64',
              commitment: 'confirmed',
            })
            .send(),
          client.rpc
            .getAccountInfo(address(wallet!), {
              encoding: 'base64',
              commitment: 'confirmed',
            })
            .send(),
        ]);
        scope.assertCurrent(version);
        const required = reviewDevnetNativeFunding(
          remaining,
          balance.value,
          rent,
          funder.value,
          recipient.value,
          [balance.context.slot, funder.context.slot, recipient.context.slot],
        );
        minimumSlot = [
          balance.context.slot,
          funder.context.slot,
          recipient.context.slot,
        ].reduce((a, b) => (a > b ? a : b));
        candidate = {
          revision: version,
          expiresAt: Date.now() + DEVNET_PREFLIGHT_LIFETIME_MS,
          key: next.key,
          required: warmupDecimal(required, 9),
          balance: warmupDecimal(balance.value, 9),
        };
      }
      const simulation = await simulateDevnetFunding(
        client,
        {
          wallet: wallet!,
          recipient: next.address,
          amount: next.amount,
          ...(latest.asset
            ? { mint: latest.asset.mint, decimals: latest.asset.decimals }
            : {}),
          minimumSlot,
        },
        () => scope.assertCurrent(version),
      );
      scope.assertCurrent(version);
      if (Date.now() >= startedAt + DEVNET_PREFLIGHT_LIFETIME_MS)
        throw new Error(
          'Funding review expired during simulation. Prepare again.',
        );
      setPrepared({
        ...candidate,
        expiresAt: startedAt + DEVNET_PREFLIGHT_LIFETIME_MS,
        simulation,
      });
      setNotice(
        'Devnet simulation passed. Review the next recipient before approving. Simulation does not reserve balances.',
      );
    } catch (err) {
      if (scope.isCurrent(version))
        setNotice(
          err instanceof Error ? err.message : 'Devnet preparation failed.',
        );
      refresh();
    } finally {
      if (scope.isCurrent(version)) setBusy(false);
    }
  }
  async function recordReceipt(
    signature: string,
    operationId: string,
    version = scope.capture(),
  ) {
    const response = await fetch('/api/wallet/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: wallet,
          signature,
          operationId,
          savedFunding: true,
        }),
      }),
      value = (await response.json()) as {
        recorded?: boolean;
        outcome?: string;
        error?: string;
      };
    if (
      !response.ok ||
      !value.recorded ||
      !['finalized', 'failed'].includes(value.outcome || '')
    )
      throw new Error(value.error || 'Funding receipt remains unresolved.');
    onReceiptChange?.();
    if (wallet)
      try {
        const raw = localStorage.getItem(`pulseforge:native-funding:${wallet}`);
        if (raw && JSON.parse(raw).id === operationId)
          localStorage.removeItem(`pulseforge:native-funding:${wallet}`);
        if (scope.isCurrent(version)) setStorageError('');
      } catch {
        if (scope.isCurrent(version))
          setStorageError(
            'Receipt verified, but local pending storage could not be cleared.',
          );
      }
    if (!scope.isCurrent(version)) return;
    setPending(null);
    setNotice(
      value.outcome === 'failed'
        ? 'Finalized transfer failure. Recipient remains unpaid; fees may have been charged. Prepare again.'
        : 'Finalized saved funding verified. Prepare a fresh review for the next recipient.',
    );
    refresh();
  }
  async function send() {
    if (
      !connected ||
      !connected.signer ||
      !wallet ||
      !matches ||
      !owned ||
      !next ||
      !prepared ||
      !prepared.simulation ||
      pending ||
      storageError ||
      !operations.ready ||
      operations.active ||
      busy ||
      prepared.expiresAt <= Date.now() ||
      prepared.key !== next.key ||
      !scope.isCurrent(prepared.revision)
    )
      return;
    const version = prepared.revision,
      signer = connected.signer;
    setBusy(true);
    setPrepared(null);
    setNotice('Waiting for one devnet transfer approval…');
    const assertReady = () => {
      scope.assertCurrent(version);
      if (
        !enabled ||
        !owned ||
        verified!.until <= Date.now() ||
        prepared.expiresAt <= Date.now()
      )
        throw new Error('Funding approval review expired. Prepare again.');
    };
    try {
      const intent = await operationDocument(
        review?.asset
          ? {
              kind: 'spl',
              wallet,
              recipient: next.address,
              distribution: {
                wallet,
                mint: review.asset.mint,
                recipients: [{ address: next.address, amount: next.amount }],
              },
              funding: { id, revision },
            }
          : {
              kind: 'sol',
              wallet,
              fundingId: id,
              fundingRevision: revision,
              recipient: next.address,
              amount: next.amount,
            },
      );
      await requireDevnet(client.rpc);
      assertReady();
      const result = await runOwnedWalletOperation(
        intent,
        assertReady,
        async (record) => {
          const submission = createWalletSubmissionClient(
            client,
            signer,
            record,
            assertReady,
          );
          if (review?.asset) {
            if (prepared.decimals !== review.asset.decimals)
              throw new Error('Saved token preparation mismatch.');
            const result = await submission.token.instructions
              .transferToATA({
                payer: submission.payer,
                authority: submission.payer,
                mint: address(review.asset.mint),
                recipient: address(next.address),
                amount: toBaseUnits(next.amount, prepared.decimals),
                decimals: prepared.decimals,
              })
              .sendTransaction();
            return result.context.signature;
          }
          const signature = await submission.system.instructions
            .transferSol({
              source: submission.payer,
              destination: address(next.address),
              amount: toBaseUnits(next.amount, 9),
            })
            .sendTransaction();
          return signature.context.signature;
        },
        (signature, operationId) => {
          if (scope.isCurrent(version))
            setPending({ signature, id: operationId });
          try {
            localStorage.setItem(
              `pulseforge:native-funding:${wallet}`,
              JSON.stringify({ signature, id: operationId }),
            );
          } catch {
            if (scope.isCurrent(version))
              setStorageError(
                'Signed identity could not be saved locally. Its server registration is still attempted.',
              );
            throw new Error(
              'Local pending funding storage failed. Use pending-operation recovery.',
            );
          }
        },
      );
      await recordReceipt(result.signature, result.id, version);
    } catch (err) {
      if (scope.isCurrent(version))
        setNotice(
          err instanceof Error
            ? err.message
            : 'Transfer outcome remains unresolved.',
        );
    } finally {
      operations.refresh();
      refresh();
      if (scope.isCurrent(version)) setBusy(false);
    }
  }
  return (
    <section
      className="wallet-holdings-panel"
      aria-label="Devnet saved funding"
    >
      <h3>Devnet {unit} funding</h3>
      <p className="source-note">
        Use this saved draft on Solana devnet with test assets. The exact saved
        mint must exist on devnet; a mainnet catalog entry does not establish
        devnet availability. Each recipient needs a separate approval and
        finalized receipt. Mainnet funding and scheduled execution remain
        unavailable.
      </p>
      <p>
        Saved revision {revision} · {review?.completed.length || 0}/
        {review?.recipients.length || 0} recipients verified.
      </p>
      <p>
        Preparation simulates the next transfer on devnet before enabling
        approval. Simulation does not reserve balances or guarantee delivery.
      </p>
      {!connected && <VaultExecutionConnect />}
      <p>
        {wallet
          ? `Connected funder: ${wallet}`
          : 'Connect an external wallet in the devnet tools or use your browser vault.'}
      </p>
      {wallet && review && !matches && (
        <p>Connect the saved funder {review.document.funderAddress}.</p>
      )}
      {!enabled && <p>Save the current active draft before execution.</p>}
      {error && <p role="alert">{error}</p>}
      {storageError && <p role="alert">{storageError}</p>}
      {next && (
        <div className="wallet-audit">
          <strong>
            Next recipient: {next.amount} {unit}
          </strong>
          <p className="warmup-address">{next.address}</p>
          <p>{remaining.length} recipients remain.</p>
        </div>
      )}
      {review?.asset && (
        <p className="warmup-address">
          Saved mint: {review.asset.mint} · {review.asset.decimals} decimals
        </p>
      )}
      {prepared?.tokenBudget && <p>{prepared.tokenBudget}</p>}
      {prepared?.simulation && (
        <p>
          Unsigned simulation passed at devnet slot {prepared.simulation.slot}.
          Quoted network fee {prepared.simulation.feeLamports} lamports at the
          review compute limit; {prepared.simulation.unitsConsumed} compute
          units consumed. Signing refreshes the blockhash and resource estimate.
        </p>
      )}
      {prepared && (
        <p>
          Devnet balance {prepared.balance} SOL · remaining budget with fee
          allowance and rent reserve {prepared.required} SOL. Preparation
          expires {new Date(prepared.expiresAt).toLocaleTimeString()}.
        </p>
      )}
      <WalletOperationPanel
        {...operations}
        available={!!wallet}
        verified={!!owned}
        onResolved={(signature) => {
          if (
            operations.active?.kind === 'sol' ||
            (operations.active?.kind === 'spl' &&
              JSON.parse(operations.active.document).funding)
          )
            void recordReceipt(signature, operations.active.id).catch((err) =>
              setNotice(
                err instanceof Error ? err.message : 'Local recovery failed.',
              ),
            );
          else refresh();
        }}
      />
      <div className="funding-actions">
        <Button disabled={!matches || busy} onClick={() => void verify()}>
          Verify funder ownership
        </Button>
        <Button
          disabled={
            !matches ||
            !owned ||
            busy ||
            loading ||
            !!pending ||
            !!storageError ||
            !next ||
            !operations.ready ||
            !!operations.active
          }
          onClick={() => void prepare()}
        >
          Prepare next devnet transfer
        </Button>
        <Button
          disabled={
            !prepared?.simulation ||
            !matches ||
            !owned ||
            busy ||
            !!pending ||
            !!storageError ||
            !!operations.active
          }
          onClick={() => void send()}
        >
          Approve one devnet {unit} transfer
        </Button>
      </div>
      {pending && (
        <>
          <code>{pending.signature}</code>
          <Button
            disabled={busy || !owned}
            onClick={() =>
              void recordReceipt(pending.signature, pending.id).catch((err) =>
                setNotice(
                  err instanceof Error ? err.message : 'Receipt unresolved.',
                ),
              )
            }
          >
            Verify retained funding receipt
          </Button>
        </>
      )}
      <Button variant="outline" disabled={busy} onClick={refresh}>
        Refresh funding receipts
      </Button>
      {notice && <output>{notice}</output>}
    </section>
  );
}
