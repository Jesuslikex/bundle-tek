'use client';
import { createAuthClient } from 'better-auth/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useImportedProjects } from './use-imported-projects';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  unlockVault,
  VAULT_STORAGE_KEY,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import { withdrawalOwnerScope } from '@/lib/native-withdrawal-owner-scope';
import {
  executeImportedTrade,
  readGroupTokenBalances,
} from '@/lib/imported-trade-execute';
import { createAutoSellFeed } from '@/lib/auto-sell-feed';
import { rawToDecimal } from '@/lib/auto-sell';
import {
  filterRecoverRows,
  readNativeBalances,
  reclaimableLamports,
  summarizeRow,
  withdrawSolToFunder,
  type RecoverRow,
} from '@/lib/recover-funds';
import styles from './recover-funds.module.css';

const auth = createAuthClient();
const FUNDER_KEY = 'bundle-default-funder-v1';
const SOL_ROW = 'sol';
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('Stopped.'));
      },
      { once: true },
    );
  });
const numOrUndef = (v: string) => {
  const n = Number(v);
  return v.trim() && Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function RecoverFunds() {
  const { data: session } = auth.useSession();
  const owner = session?.user?.id ?? null;
  const imported = useImportedProjects();
  const [wallets, setWallets] = useState<WorkspaceWallet[]>([]);
  const [funder, setFunder] = useState('');
  const [rows, setRows] = useState<RecoverRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState('');
  const [maxSupply, setMaxSupply] = useState('');
  const [minUsd, setMinUsd] = useState('');
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [archiveAfter, setArchiveAfter] = useState(true);
  const [ackAll, setAckAll] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const pausedRef = useRef(false);
  const scanRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/wallet-workspace', {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then((r) => r.json() as Promise<{ wallets?: WorkspaceWallet[] }>)
      .then((d) => {
        const list = (d.wallets ?? []).filter(
          (w) => w.chain === 'Solana' && !w.archived,
        );
        setWallets(list);
        let saved = '';
        try {
          saved = localStorage.getItem(FUNDER_KEY) ?? '';
        } catch {
          /* blocked storage */
        }
        setFunder(
          list.some((w) => w.address === saved)
            ? saved
            : (list.find((w) => w.role === 'Funder')?.address ?? ''),
        );
      })
      .catch(() => {});
    void fetch('/api/market-prices', { signal: controller.signal })
      .then(
        (r) =>
          r.json() as Promise<{ prices?: { symbol: string; usd: number }[] }>,
      )
      .then((d) =>
        setSolUsd(d.prices?.find((p) => p.symbol === 'SOL')?.usd ?? null),
      )
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const projects = useMemo(
    () =>
      imported.projects.filter(
        (p) =>
          p.document.token.chain === 'Solana' &&
          p.document.token.decimals !== undefined,
      ),
    [imported.projects],
  );
  // Proxima excludes `aged` wallets and the Funder from recovery.
  const candidates = useMemo(
    () =>
      wallets.filter((w) => w.address !== funder && !w.tags?.includes('aged')),
    [wallets, funder],
  );
  const note = (line: string) =>
    setLog((l) =>
      [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 200),
    );

  async function scan() {
    setError('');
    if (!candidates.length) return setError('No launch wallets to scan.');
    const controller = new AbortController();
    scanRef.current = controller;
    setScanning(true);
    setRows([]);
    try {
      setProgress('Reading SOL balances…');
      const native = await readNativeBalances(
        candidates.map((w) => w.address),
        controller.signal,
      );
      const found: RecoverRow[] = [];
      for (const [i, p] of projects.entries()) {
        while (pausedRef.current) await sleep(500, controller.signal);
        const token = p.document.token;
        setProgress(`Scanning ${token.symbol} (${i + 1}/${projects.length})…`);
        let held: Record<string, bigint> = {};
        try {
          if (!p.archived)
            held = await readGroupTokenBalances(
              {
                projectId: p.id,
                projectRevision: p.revision,
                mint: token.address,
              },
              candidates,
              controller.signal,
            );
        } catch (e) {
          note(
            `${token.symbol}: ${e instanceof Error ? e.message : 'holdings unavailable'}`,
          );
        }
        let price: number | null = null;
        try {
          const trades = await createAutoSellFeed(token.address)(
            controller.signal,
          );
          const v = Number(trades[0]?.priceUsd);
          price = Number.isFinite(v) && v > 0 ? v : null;
        } catch {
          price = null;
        }
        // Wallets are shared across launches, so a launch row carries only its
        // token positions; leftover SOL is one separate row below.
        const walletRows = candidates
          .map((w) => ({
            address: w.address,
            revision: w.revision,
            nativeRaw: 0n,
            tokenRaw: held[w.address] ?? 0n,
          }))
          .filter((w) => w.tokenRaw > 0n);
        found.push(
          summarizeRow(
            {
              projectId: p.id,
              symbol: token.symbol,
              archived: Boolean(p.archived),
              wallets: walletRows,
            },
            token.decimals,
            BigInt(token.totalSupplyRaw ?? '0'),
            price,
          ),
        );
        setRows([...found]);
      }
      const solWallets = candidates
        .map((w) => ({
          address: w.address,
          revision: w.revision,
          nativeRaw: native[w.address] ?? 0n,
          tokenRaw: 0n,
        }))
        .filter((w) => reclaimableLamports(w.nativeRaw) > 0n);
      found.push(
        summarizeRow(
          {
            projectId: SOL_ROW,
            symbol: 'Leftover SOL (all wallets)',
            archived: false,
            wallets: solWallets,
          },
          9,
          0n,
          null,
        ),
      );
      setRows([...found]);
      setProgress(`Scanned ${projects.length} launches.`);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Scan failed.');
      else setProgress('Scan stopped.');
    } finally {
      setScanning(false);
    }
  }

  async function unlock(): Promise<VaultSession> {
    let encrypted: string | null = null;
    try {
      encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
    } catch {
      encrypted = null;
    }
    if (!encrypted)
      throw new Error('Create or import wallets in the browser vault first.');
    const s = await unlockVault(encrypted, password).catch(() => {
      throw new Error('Wrong vault password.');
    });
    setPassword('');
    return s;
  }

  async function projectAction(
    project: ImportedTokenProject,
    action: 'archive' | 'restore',
  ) {
    const response = await fetch('/api/imported-projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action,
        id: project.id,
        expectedRevision: project.revision,
      }),
    });
    const data = (await response.json()) as {
      project?: ImportedTokenProject;
      error?: string;
    };
    if (!response.ok || !data.project)
      throw new Error(
        data.error || `Could not ${action} ${project.document.token.symbol}.`,
      );
    return data.project;
  }

  async function withdrawAll(
    label: string,
    list: { address: string; revision: number }[],
    vault: VaultSession,
    ownerScope: string,
    signal: AbortSignal,
  ) {
    if (!list.length) return;
    const native = await readNativeBalances(
      list.map((w) => w.address),
      signal,
    );
    for (const w of list) {
      const lamports = reclaimableLamports(native[w.address] ?? 0n);
      if (lamports <= 0n) continue;
      const r = await withdrawSolToFunder({
        wallet: w,
        funder,
        lamports,
        ownerScope,
        session: vault,
        signal,
      });
      note(
        `${label}: withdrew ${rawToDecimal(lamports, 9)} SOL from ${w.address.slice(0, 4)}… to the Funder (${r.signature.slice(0, 8)}…)`,
      );
    }
  }

  async function reclaim(
    row: RecoverRow,
    vault: VaultSession,
    ownerScope: string,
    signal: AbortSignal,
  ) {
    const missing = row.wallets.find(
      (w) =>
        !vault.payload.wallets.some(
          (v) => v.family === 'solana' && v.address === w.address,
        ),
    );
    if (missing)
      throw new Error(
        `Wallet ${missing.address.slice(0, 6)}… is not in this browser vault.`,
      );
    if (row.projectId === SOL_ROW)
      return withdrawAll('SOL', row.wallets, vault, ownerScope, signal);
    let project = imported.projects.find((p) => p.id === row.projectId);
    if (!project) throw new Error('Project changed. Scan again.');
    const token = project.document.token;
    const sellers = row.wallets.filter((w) => w.tokenRaw > 0n);
    if (sellers.length && project.archived) {
      project = await projectAction(project, 'restore');
      note(`${token.symbol}: restored to sell.`);
    }
    const ctx = {
      projectId: project.id,
      projectRevision: project.revision,
      mint: token.address,
      decimals: token.decimals,
      session: () => vault,
    };
    for (const w of sellers) {
      try {
        const r = await executeImportedTrade(
          ctx,
          w,
          'Sell',
          w.tokenRaw,
          signal,
        );
        note(
          `${token.symbol}: sold ${rawToDecimal(w.tokenRaw, token.decimals)} from ${w.address.slice(0, 4)}… (${r.signature.slice(0, 8)}…)`,
        );
      } catch (e) {
        note(
          `${token.symbol}: sell from ${w.address.slice(0, 4)}… failed: ${e instanceof Error ? e.message : 'error'}`,
        );
        if ((e as { uncertain?: boolean }).uncertain) throw e;
      }
    }
    if (sellers.length) await sleep(4000, signal); // let sells settle before reading SOL
    await withdrawAll(token.symbol, sellers, vault, ownerScope, signal);
    if (archiveAfter && !project.archived) {
      await projectAction(project, 'archive');
      note(`${token.symbol}: archived.`);
    }
  }

  async function run(target: RecoverRow[]) {
    setError('');
    if (!funder) return setError('Choose the default Funder first.');
    if (!owner) return setError('Sign in first.');
    let vault: VaultSession | null = null;
    const controller = new AbortController();
    scanRef.current = controller;
    setBusy('Reclaiming…');
    try {
      vault = await unlock();
      const ownerScope = await withdrawalOwnerScope(owner);
      // Launch rows first, so their sale proceeds are withdrawn with them.
      const ordered = [
        ...target.filter((r) => r.projectId !== SOL_ROW),
        ...target.filter((r) => r.projectId === SOL_ROW),
      ];
      for (const row of ordered)
        await reclaim(row, vault, ownerScope, controller.signal);
      note(
        'Reclaim finished. Rows that completed are not proof the wallets are empty; scan again to check.',
      );
      await imported.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reclaim failed.');
    } finally {
      if (vault) vault.payload.wallets = [];
      setBusy('');
    }
  }

  const visible = filterRecoverRows(
    rows,
    {
      maxSupplyPercent: numOrUndef(maxSupply),
      minUsd: numOrUndef(minUsd),
      includeEmpty,
    },
    solUsd,
  );
  const confirmRow = (row: RecoverRow) =>
    window.confirm(
      row.projectId === SOL_ROW
        ? `Withdraw leftover SOL from ${row.wallets.length} wallet(s) to the default Funder. This cannot be undone.`
        : `Reclaim ${row.symbol}: sell every token in ${row.wallets.length} wallet(s), including any developer wallet, then withdraw their SOL to the default Funder. This cannot be undone.`,
    );

  return (
    <div className={styles.panel}>
      <header>
        <p className={styles.eyebrow}>ACCOUNT · ARCHIVED · CLEAN DUST</p>
        <h1>Recover Funds</h1>
        <p>
          Scan your imported launches for leftover tokens and SOL, then reclaim
          them: sell positions and withdraw SOL to your default Funder. Each
          wallet signs its own transactions from your browser vault. A 0.00089
          SOL rent reserve stays in each wallet.
        </p>
      </header>

      <section className={styles.card}>
        <label className={styles.field}>
          <span>Default Funder</span>
          <select
            value={funder}
            onChange={(e) => {
              setFunder(e.target.value);
              try {
                localStorage.setItem(FUNDER_KEY, e.target.value);
              } catch {
                /* blocked storage */
              }
            }}
          >
            <option value="">Choose a wallet</option>
            {wallets.map((w) => (
              <option key={w.address} value={w.address}>
                {w.label || w.address.slice(0, 8)}{' '}
                {w.role === 'Funder' ? '(Funder)' : ''} ·{' '}
                {w.address.slice(0, 4)}…{w.address.slice(-4)}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.filters}>
          <label className={styles.field}>
            <span>Max. Supply (%)</span>
            <input
              inputMode="decimal"
              value={maxSupply}
              onChange={(e) => setMaxSupply(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Min. USD</span>
            <input
              inputMode="decimal"
              value={minUsd}
              onChange={(e) => setMinUsd(e.target.value)}
            />
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={includeEmpty}
              onChange={(e) => setIncludeEmpty(e.target.checked)}
            />
            Include Empty Launches
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={archiveAfter}
              onChange={(e) => setArchiveAfter(e.target.checked)}
            />
            Archive after completion
          </label>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            disabled={scanning || Boolean(busy)}
            onClick={() => void scan()}
          >
            {rows.length ? 'Scan again' : 'Scan launches'}
          </button>
          {scanning && (
            <button
              type="button"
              onClick={() => {
                pausedRef.current = !paused;
                setPaused(!paused);
              }}
            >
              {paused ? 'Resume scan' : 'Pause scan'}
            </button>
          )}
          {progress && <small>{progress}</small>}
        </div>
        <small>
          Pause only pauses the scan, not transactions already submitted. Each
          holdings read waits out the 15-second account read limit.
        </small>
      </section>

      <section className={styles.card}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Launch</th>
              <th>Tokens</th>
              <th>Supply</th>
              <th>Token value</th>
              <th>SOL to reclaim</th>
              <th>
                <span className={styles.sr}>Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.projectId}>
                <td>
                  {r.symbol}
                  {r.archived && <em> archived (restore to scan tokens)</em>}
                  <small>{r.wallets.length} wallet(s)</small>
                </td>
                <td>
                  {r.projectId === SOL_ROW
                    ? '—'
                    : rawToDecimal(
                        r.tokenRaw,
                        projects.find((p) => p.id === r.projectId)?.document
                          .token.decimals ?? 0,
                      )}
                </td>
                <td>
                  {r.projectId === SOL_ROW
                    ? '—'
                    : `${r.supplyPercent.toFixed(2)}%`}
                </td>
                <td>
                  {r.tokenUsd === null ? '—' : `$${r.tokenUsd.toFixed(2)}`}
                </td>
                <td>
                  {r.projectId === SOL_ROW
                    ? rawToDecimal(r.nativeLamports, 9)
                    : 'after sale'}
                </td>
                <td>
                  <button
                    type="button"
                    disabled={Boolean(busy) || scanning || r.empty}
                    onClick={() => confirmRow(r) && void run([r])}
                  >
                    Reclaim
                  </button>
                </td>
              </tr>
            ))}
            {!visible.length && (
              <tr>
                <td colSpan={6}>
                  {rows.length
                    ? 'No launches match the filters.'
                    : 'Scan to find leftover funds.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className={styles.card}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={ackAll}
            onChange={(e) => setAckAll(e.target.checked)}
          />
          I understand Reclaim all sells (Nuke) every listed position and
          withdraws to the default Funder. It cannot be undone.
        </label>
        <div className={styles.actions}>
          <input
            type="password"
            aria-label="Vault password"
            placeholder="Vault password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            disabled={
              !ackAll ||
              Boolean(busy) ||
              scanning ||
              !visible.some((r) => !r.empty)
            }
            onClick={() => void run(visible.filter((r) => !r.empty))}
          >
            Reclaim all
          </button>
          <button
            type="button"
            disabled={
              Boolean(busy) ||
              scanning ||
              !visible.some((r) => !r.archived && r.projectId !== SOL_ROW)
            }
            onClick={async () => {
              setBusy('Archiving…');
              setError('');
              try {
                for (const r of visible.filter(
                  (x) => !x.archived && x.projectId !== SOL_ROW,
                )) {
                  const p = imported.projects.find((x) => x.id === r.projectId);
                  if (p) await projectAction(p, 'archive');
                }
                note('Archived the listed launches. No assets moved.');
                await imported.refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Archive failed.');
              } finally {
                setBusy('');
              }
            }}
          >
            Archive All
          </button>
          {busy && <small>{busy}</small>}
        </div>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {log.length > 0 && (
          <ul className={styles.log} aria-label="Recovery activity">
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
