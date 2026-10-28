'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ChefHat,
  ChevronDown,
  Download,
  HelpCircle,
  Search,
  ShoppingCart,
  Trash2,
  ChevronUp,
  Filter,
  Folder,
  RefreshCw,
  User,
  Wallet,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import { formatRawAmount as formatRaw } from '@/lib/supply-analysis';
import {
  CLEANUP_MAX_WALLETS,
  cleanupTotals,
  isCleanupBuy,
  isCleanupSell,
  signWalletCleanupBatch,
  validatedWalletCleanup,
  type CleanupSkipReason,
  type WalletCleanup,
} from '@/lib/wallet-cleanup';
import {
  CLEANUP_DEFAULT_DELAY_MS,
  CLEANUP_DEFAULT_MAX_DELAY_MS,
  CLEANUP_MAX_DELAY_MS,
  CLEANUP_MIN_DELAY_MS,
  cleanupDelayMs,
  cleanupDelayParts,
  cleanupPayload,
  type CleanupDelayMode,
  type CleanupPayload,
} from '@/lib/wallet-cleanup-plan';
import type { WalletBalance } from '@/lib/wallet-balance-format';
import type { WalletFolder, WorkspaceWallet } from '@/lib/wallet-workspace';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import styles from './wallet-cleanup-panel.module.css';

const SKIP_LABEL: Record<CleanupSkipReason, string> = {
  'holds-tokens': 'holds tokens (sell first)',
  frozen: 'frozen',
  'foreign-close-authority': 'another close authority',
  'withheld-fees': 'withheld transfer fees',
  'unsupported-extension': 'unsupported Token-2022 extension',
  'over-limit': 'over 20 accounts (run again)',
};
const sol = (lamports: bigint | string) =>
  formatNativeBalance(String(lamports), 9) + ' SOL';
const short = (address: string) =>
  address.slice(0, 4) + '…' + address.slice(-4);
const pair = (ms: number) => {
  const { minutes, seconds } = cleanupDelayParts(ms);
  return { minutes: String(minutes), seconds: String(seconds) };
};
const pad = (value: string) => value.padStart(2, '0').slice(-2);

type Batch = {
  batchId: string;
  stage: 'sell' | 'close';
  plan?: CleanupPayload;
  rounds?: { round: number; seller: string; buyer: string }[];
  cleanups: WalletCleanup[];
  errors: { wallet: string; mint?: string; error: string }[];
  empty: string[];
  remaining: number;
};

type StatusKey = 'planned' | 'running' | 'completed' | 'failed' | 'cancelled';
const STATUS_LABEL: Record<StatusKey, string> = {
  planned: 'Awaiting Signature',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Proxima's WALLET_TYPES: dev -> chef (yellow), funder -> wallet, holder -> user. */
type Bounds = { min: string; max: string };

// Proxima's Filter: a funnel that opens a floating panel anchored under the
// header cell, closing on outside click or Escape.
function FilterPopover({
  active,
  label,
  bounds,
  onChange,
}: {
  active: boolean;
  label: string;
  bounds: Bounds;
  onChange: (next: Bounds) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      const size = panel.current?.getBoundingClientRect();
      if (!box || !size) return;
      const left = Math.min(
        Math.max(box.left + box.width / 2 - size.width / 2, 8),
        window.innerWidth - size.width - 8,
      );
      setPos({ top: box.bottom + 4, left });
    };
    place();
    requestAnimationFrame(place);
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.filterButton}
        aria-label={`Filter ${label}`}
        aria-expanded={open}
        data-active={active ? 'true' : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <Filter size={10} />
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              className={styles.filterModal}
              style={{ top: pos.top, left: pos.left }}
            >
              <p>{label}</p>
              <div className={styles.filterInputs}>
                <input
                  className={styles.filterInput}
                  aria-label={`Min ${label}`}
                  placeholder={`Min ${label}`}
                  value={bounds.min}
                  onChange={(event) =>
                    onChange({ ...bounds, min: event.target.value })
                  }
                />
                <p>-</p>
                <input
                  className={styles.filterInput}
                  aria-label={`Max ${label}`}
                  placeholder={`Max ${label}`}
                  value={bounds.max}
                  onChange={(event) =>
                    onChange({ ...bounds, max: event.target.value })
                  }
                />
              </div>
              <div className={styles.filterFooter}>
                <button
                  type="button"
                  className={styles.filterReset}
                  onClick={() => onChange({ min: '', max: '' })}
                >
                  <RefreshCw size={12} />
                  Reset
                </button>
                <button
                  type="button"
                  className={styles.filterApply}
                  onClick={() => setOpen(false)}
                >
                  Apply
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// Proxima's FolderFilterModal: a searchable folder checklist with a Reset /
// Apply footer.
function FolderFilterPopover({
  folders,
  selected,
  purchasedOnly,
  onChange,
  onPurchasedOnly,
}: {
  folders: WalletFolder[];
  selected: string[];
  purchasedOnly: boolean;
  onChange: (next: string[]) => void;
  onPurchasedOnly: (next: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      const size = panel.current?.getBoundingClientRect();
      if (!box || !size) return;
      setPos({
        top: box.bottom + 4,
        left: Math.min(Math.max(box.left, 8), window.innerWidth - size.width - 8),
      });
    };
    place();
    requestAnimationFrame(place);
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const shown = folders.filter((folder) =>
    folder.name.toLowerCase().includes(term.trim().toLowerCase()),
  );

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.filterButton}
        aria-label="Filter by folder"
        aria-expanded={open}
        data-active={selected.length > 0 || purchasedOnly ? 'true' : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <Filter size={10} />
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              className={`${styles.filterModal} ${styles.folderModal}`}
              style={{ top: pos.top, left: pos.left }}
            >
              <p>Filter by folder</p>
              <input
                className={styles.filterInput}
                aria-label="Search folders"
                placeholder="Search folders"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
              />
              <label className={styles.folderRow}>
                <span className={styles.folderMeta}>
                  <p>Purchased wallets only</p>
                </span>
                <input
                  type="checkbox"
                  aria-label="Purchased wallets only"
                  checked={purchasedOnly}
                  onChange={(event) => onPurchasedOnly(event.target.checked)}
                />
              </label>
              <div className={styles.folderList}>
                {shown.length === 0 ? (
                  <p className={styles.folderEmpty}>No folders found</p>
                ) : (
                  shown.map((folder) => (
                    <div
                      key={folder.id}
                      className={styles.folderRow}
                      onClick={() =>
                        onChange(
                          selected.includes(folder.id)
                            ? selected.filter((id) => id !== folder.id)
                            : [...selected, folder.id],
                        )
                      }
                    >
                      <span className={styles.folderMeta}>
                        <Folder size={14} color={folder.color} />
                        <p>{folder.name}</p>
                      </span>
                      <input
                        type="checkbox"
                        aria-label={`Folder ${folder.name}`}
                        checked={selected.includes(folder.id)}
                        onChange={() => {}}
                      />
                    </div>
                  ))
                )}
              </div>
              <div className={styles.filterFooter}>
                <button
                  type="button"
                  className={styles.filterReset}
                  onClick={() => {
                    onChange([]);
                    onPurchasedOnly(false);
                  }}
                >
                  <RefreshCw size={12} />
                  Reset
                </button>
                <button
                  type="button"
                  className={styles.filterApply}
                  onClick={() => setOpen(false)}
                >
                  Apply
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

const roleIcon = (role: string) => {
  if (role === 'Deployer') return <ChefHat size={13} color="rgb(var(--yellow, 234 179 8))" />;
  if (role === 'Funder') return <Wallet size={12} color="rgb(var(--wallet-funder, 148 163 184))" />;
  return <User size={11} color="rgb(var(--text-3, 148 163 184))" />;
};

const hasSol = (balances: WalletBalance[] | undefined, address: string) =>
  Number(balances?.find((b) => b.address === address)?.raw ?? 0) > 0;

const solBalance = (balances: WalletBalance[] | undefined, address: string) => {
  const balance = balances?.find((b) => b.address === address);
  return balance
    ? `${formatNativeBalance(balance.raw, balance.decimals)} SOL`
    : '—';
};

async function request(body: object, signal?: AbortSignal) {
  const response = await fetch('/api/wallet-workspace/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const value = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw new Error(
      typeof value.error === 'string' ? value.error : 'Cleanup unavailable.',
    );
  return value;
}

/** Proxima's cleanup: sell from the input wallets into the output wallets. */
export function WalletCleanupPanel({
  wallets,
  balances,
  folders = [],
  selected,
}: {
  wallets: WorkspaceWallet[];
  balances?: WalletBalance[];
  folders?: WalletFolder[];
  selected: WorkspaceWallet[];
}) {
  const field = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false),
    [inputs, setInputs] = useState<string[]>([]),
    [outputs, setOutputs] = useState<string[]>([]),
    [delayMode, setDelayMode] = useState<CleanupDelayMode>('Fixed'),
    [segBox, setSegBox] = useState({ width: 0, left: 0 }),
    [delay, setDelay] = useState(pair(CLEANUP_DEFAULT_DELAY_MS)),
    [delayMax, setDelayMax] = useState(pair(CLEANUP_DEFAULT_MAX_DELAY_MS)),
    [doubleBuy, setDoubleBuy] = useState(''),
    [altRouting, setAltRouting] = useState(''),
    [advanced, setAdvanced] = useState(false),
    [picker, setPicker] = useState<'input' | 'output' | null>(null),
    [query, setQuery] = useState(''),
    [folderFilter, setFolderFilter] = useState<string[]>([]),
    [purchasedOnly, setPurchasedOnly] = useState(false),
    [filters, setFilters] = useState<{ token: Bounds; sol: Bounds }>({
      token: { min: '', max: '' },
      sol: { min: '', max: '' },
    }),
    [sort, setSort] = useState<{
      key: 'wallet' | 'token' | 'sol';
      dir: 'asc' | 'desc';
    }>({ key: 'wallet', dir: 'asc' }),
    [draft, setDraft] = useState<string[]>([]),
    [batch, setBatch] = useState<Batch | null>(null),
    roundDelay = () => {
      const min = batch?.plan?.min_delay_ms ?? 0;
      const max = batch?.plan?.max_delay_ms ?? min;
      return min === max ? min : min + Math.floor(Math.random() * (max - min + 1));
    },
    [accepted, setAccepted] = useState(false),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [supply, setSupply] = useState<{
      mint: string | null;
      supplyRaw: string;
      decimals: number;
      balances: Record<string, string>;
    } | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch('/api/wallet-workspace/cleanup/holdings', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        if (mounted.current && v) setSupply(v as typeof supply);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [open]);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const segRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const measure = () => {
      const index = (['Fixed', 'Random'] as const).indexOf(delayMode);
      const el = segRefs.current[index];
      if (el) setSegBox({ width: el.offsetWidth, left: el.offsetLeft });
    };
    const frame = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
    };
  }, [delayMode, open]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = wallets.filter((w) => w.chain === 'Solana' && !w.archived);
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const addresses = selected
      .map((w) => w.address)
      .filter((a) => active.some((w) => w.address === a));
    if (addresses.length)
      setInputs(addresses.slice(0, CLEANUP_MAX_WALLETS));
  }, []);
  // A reload mid-batch must not lose the run: restore the newest batch when a
  // leg is still waiting on a signature.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    void (async () => {
      // A resume is a convenience restore: a transport failure (or a fetch mock
      // that cannot resolve a relative URL) must stay silent, not reject.
      let response: Response;
      try {
        response = await fetch('/api/wallet-workspace/cleanup?latest=1');
      } catch {
        return;
      }
      if (!response.ok) return;
      const value = (await response.json().catch(() => ({}))) as {
        cleanups?: WalletCleanup[];
      };
      if (!value.cleanups?.length) return;
      const cleanups = await Promise.all(
        value.cleanups.map((row) => validatedWalletCleanup(row)),
      );
      const live = cleanups.some((r) =>
        ['awaiting_signature', 'signing', 'pending'].includes(r.state),
      );
      if (!live) return;
      setBatch({
        batchId: cleanups[0].batchId,
        stage: 'sell',
        cleanups,
        errors: [],
        empty: [],
        remaining: 0,
      });
      setOpen(true);
    })();
  }, []);
  // The launch settings Cleanup card links here with #cleanup; open on arrival
  // so the card reaches the dialog rather than the top of the page.
  useEffect(() => {
    if (window.location.hash !== '#cleanup') return;
    setOpen(true);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  const byAddress = new Map(active.map((w) => [w.address, w]));
  const rows = batch?.cleanups ?? [];
  const pending = rows.filter((r) => r.state === 'awaiting_signature');
  const totals = cleanupTotals(rows.map((r) => r.document));
  const labelOf = (address: string) => {
    const wallet = byAddress.get(address);
    return wallet ? wallet.label : short(address);
  };
  const roleOf = (address: string) => byAddress.get(address)?.role ?? '';
  const reset = () => {
    epoch.current++;
    setBatch(null);
    setAccepted(false);
    setNotice('');
    setError('');
  };
  const merge = (updated: WalletCleanup) =>
    setBatch((b) =>
      b
        ? {
            ...b,
            cleanups: b.cleanups.map((r) =>
              r.id === updated.id ? updated : r,
            ),
          }
        : b,
    );

  const minDelayMs = cleanupDelayMs(delay.minutes, delay.seconds);
  const maxDelayMs =
    delayMode === 'Fixed'
      ? minDelayMs
      : cleanupDelayMs(delayMax.minutes, delayMax.seconds);
  const plan = {
    inputWalletPubkeys: inputs,
    outputWalletPubkeys: outputs,
    minDelayMs,
    maxDelayMs,
    doubleBuyPct: Number(doubleBuy) || 0,
    fakeTipPct: Number(altRouting) || 0,
  };

  function openPicker(side: 'input' | 'output') {
    setPicker(side);
    setDraft(side === 'input' ? inputs : outputs);
    setQuery('');
    setError('');
  }
  function commitPicker() {
    if (picker === 'input') setInputs(draft);
    else if (picker === 'output') setOutputs(draft);
    setPicker(null);
  }
  function toggleDraft(address: string) {
    setDraft((list) =>
      list.includes(address)
        ? list.filter((a) => a !== address)
        : list.length >= CLEANUP_MAX_WALLETS
          ? list
          : [...list, address],
    );
  }

  async function run() {
    reset();
    setBusy(true);
    try {
      const payload = cleanupPayload(plan);
      const value = (await request({ action: 'run', ...payload })) as Batch;
      for (const row of value.cleanups) await validatedWalletCleanup(row);
      if (
        value.cleanups.some(
          (r) =>
            r.batchId !== value.batchId ||
            !payload.output_wallet_pubkeys.includes(r.document.destination),
        )
      )
        throw new Error('Cleanup review differs from the request.');
      if (mounted.current) setBatch(value);
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : 'Cleanup unavailable.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function approve() {
    if (!batch || !pending.length || !accepted) return;
    const current = epoch.current;
    const assertCurrent = () => {
      if (current !== epoch.current || !mounted.current)
        throw new Error('Cleanup review changed. Nothing further was signed.');
    };
    setBusy(true);
    setError('');
    let begun = false,
      signedAny = false;
    try {
      // Unlock first: begin_signing may re-quote an expired buy-back, and the
      // blockhash window must not be spent on the key derivation.
      const session = await unlockVault(
        localStorage.getItem(VAULT_STORAGE_KEY) || '',
        password,
      );
      setPassword('');
      const started = (await request({
        action: 'begin_signing',
        batchId: batch.batchId,
      })) as { cleanups: WalletCleanup[] };
      begun = true;
      setBatch({ ...batch, cleanups: started.cleanups });
      // Sign the documents the server just claimed: an expired buy-back is
      // re-quoted during begin_signing, so the local copies may be stale.
      const reviews = started.cleanups
        .filter((r) => r.state === 'signing')
        .map((r) => r.document);
      let signed: Awaited<ReturnType<typeof signWalletCleanupBatch>>;
      try {
        assertCurrent();
        signed = await signWalletCleanupBatch(session, reviews, assertCurrent);
        signedAny = true;
      } finally {
        session.payload.wallets.forEach((w) => {
          w.seed = '';
        });
        session.payload.wallets.length = 0;
      }
      let submitted = 0;
      const failures: string[] = [];
      let index = 0;
      for (const s of signed) {
        try {
          if (index++ > 0) await pause(roundDelay());
          const registered = (await request({
            action: 'register',
            id: s.id,
            transaction: s.transaction,
          })) as { cleanup: WalletCleanup };
          merge(registered.cleanup);
          const sent = (await request({
            action: 'submit',
            id: s.id,
            transaction: s.transaction,
          })) as { cleanup: WalletCleanup };
          merge(sent.cleanup);
          submitted++;
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
      setNotice(failures.join(' '));
    } catch (err) {
      if (begun && !signedAny)
        for (const row of pending)
          await request({
            action: 'reject_signing',
            id: row.id,
            noSignatureVerified: true,
          })
            .then((value) =>
              merge((value as { cleanup: WalletCleanup }).cleanup),
            )
            .catch(() => undefined);
      if (mounted.current)
        setError(
          err instanceof Error ? err.message : 'Cleanup signing failed.',
        );
    } finally {
      if (mounted.current) {
        setBusy(false);
        setAccepted(false);
        setPassword('');
      }
    }
  }

  async function refresh(batchId: string) {
    const response = await fetch(
      `/api/wallet-workspace/cleanup?batchId=${encodeURIComponent(batchId)}`,
    );
    if (!response.ok) return;
    const value = (await response.json().catch(() => ({}))) as {
      cleanups?: WalletCleanup[];
    };
    if (!value.cleanups || !mounted.current) return;
    const cleanups = await Promise.all(
      value.cleanups.map((row) => validatedWalletCleanup(row)),
    );
    setBatch((b) => (b ? { ...b, cleanups } : b));
  }

  async function recover() {
    setBusy(true);
    setError('');
    try {
      for (const row of rows.filter((r) =>
        ['signed', 'submitted'].includes(r.state),
      )) {
        try {
          const value = (await request({ action: 'recover', id: row.id })) as {
            cleanup: WalletCleanup;
          };
          merge(await validatedWalletCleanup(value.cleanup));
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Outcome unavailable.');
        }
      }
      // A finalized sell prepares its buy-back on the buyer; pull it in so the
      // next packet can be signed without reloading the page.
      if (batch) await refresh(batch.batchId);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function cancel() {
    if (!batch) return;
    setBusy(true);
    try {
      const value = (await request({
        action: 'cancel',
        batchId: batch.batchId,
      })) as { cleanups: WalletCleanup[] };
      epoch.current++;
      setBatch({ ...batch, cleanups: value.cleanups });
      setAccepted(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel unavailable.');
    } finally {
      setBusy(false);
    }
  }

  const tokenOf = (address: string) =>
    Number(supply?.balances?.[address] ?? 0) / 10 ** (supply?.decimals ?? 0);
  const solOf = (address: string) =>
    Number(balances?.find((b) => b.address === address)?.raw ?? 0) / 1e9;
  const within = (value: number, bounds: Bounds) => {
    const min = bounds.min === '' ? null : Number(bounds.min);
    const max = bounds.max === '' ? null : Number(bounds.max);
    if (min !== null && !Number.isNaN(min) && value < min) return false;
    if (max !== null && !Number.isNaN(max) && value > max) return false;
    return true;
  };
  const pickerWallets = active
    .filter((w) => {
      const q = query.trim().toLowerCase();
      return (
        (!q ||
          w.address.toLowerCase().includes(q) ||
          w.label.toLowerCase().includes(q)) &&
        (!purchasedOnly || (w.tags ?? []).includes('purchased')) &&
        (folderFilter.length === 0 ||
          (w.folderIds?.length ? w.folderIds : w.folderId ? [w.folderId] : []).some(
            (id) => folderFilter.includes(id),
          )) &&
        within(tokenOf(w.address), filters.token) &&
        within(solOf(w.address), filters.sol)
      );
    })
    .slice(0, 200);
  const sortValue = (w: WorkspaceWallet) =>
    sort.key === 'wallet'
      ? (w.label || w.address).toLowerCase()
      : sort.key === 'token'
        ? Number(supply?.balances?.[w.address] ?? 0)
        : Number(balances?.find((b) => b.address === w.address)?.raw ?? 0);
  const sortedWallets = [...pickerWallets].sort((a, b) => {
    const left = sortValue(a);
    const right = sortValue(b);
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    return sort.dir === 'asc' ? order : -order;
  });

  // Proxima's header cell: the label and a stacked asc/desc pair, the active
  // direction lit. Clicking the cell toggles the direction.
  const sortHead = (
    key: 'wallet' | 'token' | 'sol',
    label: string,
    filterName?: 'token' | 'sol',
  ) => (
    <span className={styles.headCell}>
      <button
        type="button"
        className={styles.sortHead}
        data-sort={`${sort.key}:${sort.dir}`}
        onClick={() =>
          setSort((s) =>
            s.key === key
              ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
              : { key, dir: 'asc' },
          )
        }
      >
        {label}
        <span className={styles.sortIcons}>
          <ChevronUp
            size={10}
            style={{ color: sort.key === key && sort.dir === 'asc' ? 'inherit' : undefined }}
          />
          <ChevronDown
            size={10}
            style={{ color: sort.key === key && sort.dir === 'desc' ? 'inherit' : undefined }}
          />
        </span>
      </button>
      {key === 'wallet' ? (
        <FolderFilterPopover
          folders={folders}
          selected={folderFilter}
          purchasedOnly={purchasedOnly}
          onChange={setFolderFilter}
          onPurchasedOnly={setPurchasedOnly}
        />
      ) : null}
      {filterName ? (
        <FilterPopover
          active={filters[filterName].min !== '' || filters[filterName].max !== ''}
          label={filterName === 'token' ? 'Token %' : 'Balance'}
          bounds={filters[filterName]}
          onChange={(next) => setFilters((f) => ({ ...f, [filterName]: next }))}
        />
      ) : null}
    </span>
  );

  const status: StatusKey = rows.some((r) => r.state === 'awaiting_signature')
    ? 'planned'
    : rows.some((r) => ['signed', 'submitted'].includes(r.state))
      ? 'running'
      : rows.some((r) => r.state === 'failed')
        ? 'failed'
        : rows.length > 0 && rows.every((r) => r.state === 'cancelled')
          ? 'cancelled'
          : 'completed';
  const settled = rows.filter((r) => r.state === 'finalized').length;
  const progress = rows.length ? settled / rows.length : 0;
  const summary =
    status === 'planned'
      ? `${pending.length} transaction(s) ready to sign.`
      : status === 'running'
        ? `${settled} of ${rows.length} settled. Check outcomes after they finalize.`
        : status === 'completed'
          ? `${rows.length} round(s) settled.`
          : status === 'cancelled'
            ? `${rows.length} round(s) cancelled.`
            : `${rows.filter((r) => r.state === 'failed').length} of ${rows.length} failed.`;
  const sellTotal = rows.reduce(
    (sum, r) => (isCleanupSell(r.document) ? sum + BigInt(r.document.amountRaw) : sum),
    0n,
  );
  const tokenBalanceOf = (address: string) => {
    const raw = supply?.balances?.[address];
    if (!raw) return '-';
    const value = Number(raw) / 10 ** (supply?.decimals ?? 0);
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };
  const shareOf = (address: string) => {
    const raw = supply?.balances?.[address];
    const total = Number(supply?.supplyRaw ?? 0);
    if (raw && total > 0)
      return `${((Number(raw) / total) * 100).toFixed(2)}%`;
    if (!sellTotal) return '-';
    const amount = rows.reduce(
      (sum, r) =>
        isCleanupSell(r.document) && r.document.wallet === address
          ? sum + BigInt(r.document.amountRaw)
          : sum,
      0n,
    );
    if (!amount) return '-';
    return `${((Number(amount) / Number(sellTotal)) * 100).toFixed(1)}%`;
  };
  // Proxima totals the token percentages. Supply shares are known up front;
  // without them the sell amounts of a prepared batch are the only source, and
  // before either exists the wallet count stands in.
  const shareTotal = (list: string[]) =>
    list
      .reduce((sum, a) => sum + (shareOf(a) === '-' ? 0 : parseFloat(shareOf(a))), 0)
      .toFixed(1);
  const totalText = (list: string[]) =>
    list.some((a) => supply?.balances?.[a]) || rows.some((r) => isCleanupSell(r.document))
      ? `${shareTotal(list)}%`
      : `${list.length}`;

  const walletColumn = (
    side: 'input' | 'output',
    list: string[],
    setList: (value: string[]) => void,
  ) => (
    <div className={styles.walletSelection}>
      <div className={styles.walletSelectionHeader}>
        <h2>{side === 'input' ? 'Input Wallets (Sellers)' : 'Output Wallets (Buyers)'}</h2>
        <button
          type="button"
          className={styles.addButton}
          disabled={busy}
          onClick={() => openPicker(side)}
        >
          Select ({list.length})
        </button>
      </div>
      <div className={styles.walletSelectionBody}>
        {list.length ? (
          list.map((address) => (
            <div className={styles.walletRowContainer} key={address}>
              <div className={styles.walletRow}>
                <div className={styles.walletRowAddress}>
                  <span className={styles.walletAddress} title={address}>
                    {roleIcon(roleOf(address))}
                    {labelOf(address)}
                  </span>
                  {roleOf(address) && (
                    <span className={styles.badge}>{roleOf(address)}</span>
                  )}
                  <span className={styles.subLabel}>%</span>
                </div>
                <span className={styles.walletRowBalance}>
                  {shareOf(address)}
                </span>
              </div>
              <button
                type="button"
                className={styles.walletRowRemove}
                aria-label={`Remove ${short(address)}`}
                disabled={busy}
                onClick={() => setList(list.filter((a) => a !== address))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        ) : (
          <div className={styles.emptyWallets}>No wallets selected</div>
        )}
      </div>
      <div className={styles.totalContainer}>
        <p>Total</p>
        <p>{totalText(list)}</p>
      </div>
    </div>
  );

  const durationField = (
    label: string,
    value: { minutes: string; seconds: string },
    set: (value: { minutes: string; seconds: string }) => void,
  ) => (
    <div className={styles.duration}>
      {label && (
        <div className={styles.durationHead}>
          <label>{label}</label>
        </div>
      )}
      <div className={styles.inputDuration}>
        <div className={`${styles.inputDurationItem} ${styles.active}`}>
          <label>MIN</label>
          <input
            type="number"
            aria-label={(label || 'Delay') + ' minutes'}
            placeholder="00"
            value={value.minutes}
            onChange={(e) => set({ ...value, minutes: e.target.value })}
          />
        </div>
        <div className={styles.spacer}>:</div>
        <div className={`${styles.inputDurationItem} ${styles.active}`}>
          <label>SEC</label>
          <input
            type="number"
            aria-label={(label || 'Delay') + ' seconds'}
            placeholder="00"
            value={value.seconds}
            onChange={(e) => set({ ...value, seconds: e.target.value })}
          />
        </div>
      </div>
    </div>
  );

  const percentField = (
    id: string,
    label: string,
    helper: string,
    value: string,
    set: (value: string) => void,
  ) => (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <label htmlFor={id}>{label}</label>
        <span className={styles.tooltip} data-tip={helper}>
          <HelpCircle size={14} />
        </span>
      </div>
      <div className={styles.inputContainer}>
        <input
          id={id}
          type="number"
          placeholder="0"
          aria-label={label.replace(' (optional)', '')}
          value={value}
          onChange={(e) => set(e.target.value)}
        />
        <span className={styles.currency}>%</span>
      </div>
    </div>
  );

  return (
    <section className={styles.panel} aria-label="Cleanup">
      <div className={styles.panelHead}>
        <h3>Cleanup</h3>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            reset();
            setOpen(!open);
          }}
        >
          {open ? 'Close' : 'Configure'}
        </Button>
      </div>
      {open && (
        <div className={styles.backdrop} role="presentation">
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label="Cleanup"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                if (picker) setPicker(null);
                else setOpen(false);
              }
            }}
          >
            <div className={styles.head}>
              <h2>Cleanup</h2>
              <div className={styles.headActions}>
                <button
                  type="button"
                  className={styles.closeButton}
                  aria-label="Close cleanup"
                  onClick={() => setOpen(false)}
                >
                  ×
                </button>
              </div>
            </div>

            {batch ? (
              <div className={styles.statusPanel}>
                <div className={styles.top}>
                  <div className={`${styles.status} ${styles[status]}`}>
                    {STATUS_LABEL[status]}
                  </div>
                </div>
                {status === 'running' && (
                  <div className={styles.progress}>
                    <div className={styles.progressText}>
                      <span>Progress</span>
                      <span>
                        {settled} / {rows.length} rounds
                      </span>
                    </div>
                    <div className={styles.progressBar}>
                      <div
                        className={styles.progressBarFill}
                        style={{ width: `${Math.min(progress * 100, 100)}%` }}
                      />
                    </div>
                  </div>
                )}
                <div className={styles.configInfo}>
                  <h3>Configuration</h3>
                  <div className={styles.configRow}>
                    <p>{minDelayMs === maxDelayMs ? 'Delay' : 'Delay Range'}</p>
                    <p>
                      {minDelayMs === maxDelayMs
                        ? `${minDelayMs / 1000}s`
                        : `${minDelayMs / 1000}s - ${maxDelayMs / 1000}s`}
                    </p>
                  </div>
                  <div className={styles.configRow}>
                    <p>Method</p>
                    <p>Buyback</p>
                  </div>
                  {plan.doubleBuyPct > 0 && (
                    <div className={styles.configRow}>
                      <p>Double Buy %</p>
                      <p>{plan.doubleBuyPct}%</p>
                    </div>
                  )}
                  {plan.fakeTipPct > 0 && (
                    <div className={styles.configRow}>
                      <p>Fake Tip %</p>
                      <p>{plan.fakeTipPct}%</p>
                    </div>
                  )}
                  <h3 className={styles.statsTitle}>Statistics</h3>
                  <div className={styles.configRow}>
                    <p>Rounds</p>
                    <p>{batch.rounds?.length ?? 0}</p>
                  </div>
                  <div className={styles.configRow}>
                    <p>Transactions</p>
                    <p>{rows.length}</p>
                  </div>
                  <div className={styles.configRow}>
                    <p>Expected SOL</p>
                    <p>{sol(totals.minimumSellOut)}</p>
                  </div>
                  {totals.buys > 0 && (
                    <div className={styles.configRow}>
                      <p>Buy-backs</p>
                      <p>
                        {totals.buys} wallet(s),{' '}
                        {formatRaw(
                          totals.minimumBuyOut,
                          rows
                            .map((r) => r.document)
                            .find(isCleanupBuy)?.decimals ?? 0,
                        )}{' '}
                        tokens
                      </p>
                    </div>
                  )}
                </div>
                {(inputs.length > 0 || outputs.length > 0) && (
                  <div className={styles.statusWalletSection}>
                    <div className={styles.statusWalletColumn}>
                      <h3>Input Wallets ({inputs.length})</h3>
                      <div className={styles.statusWalletList}>
                        {inputs.map((address) => (
                          <div className={styles.statusWalletRow} key={address}>
                            <div className={styles.statusWalletAddress}>
                              <span className={styles.walletAddress} title={address}>
                                {labelOf(address)}
                              </span>
                              {roleOf(address) && (
                                <span className={styles.badge}>{roleOf(address)}</span>
                              )}
                            </div>
                            <span className={styles.statusWalletBalance}>
                              {shareOf(address)}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className={styles.totalContainer}>
                        <p>Total</p>
                        <p>{totalText(inputs)}</p>
                      </div>
                    </div>
                    <div className={styles.statusWalletColumn}>
                      <h3>Output Wallets ({outputs.length})</h3>
                      <div className={styles.statusWalletList}>
                        {outputs.map((address) => (
                          <div className={styles.statusWalletRow} key={address}>
                            <div className={styles.statusWalletAddress}>
                              <span className={styles.walletAddress} title={address}>
                                {labelOf(address)}
                              </span>
                              {roleOf(address) && (
                                <span className={styles.badge}>{roleOf(address)}</span>
                              )}
                            </div>
                            <span className={styles.statusWalletBalance}>
                              {shareOf(address)}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className={styles.totalContainer}>
                        <p>Total</p>
                        <p>{totalText(outputs)}</p>
                      </div>
                    </div>
                  </div>
                )}
                {batch.errors.length > 0 && (
                  <ul className={styles.errors}>
                    {batch.errors.map((e, i) => (
                      <li key={e.wallet + i}>
                        {short(e.wallet)}: {e.error}
                      </li>
                    ))}
                  </ul>
                )}
                {batch.empty.length > 0 && (
                  <p className={styles.helper}>
                    {batch.empty.length} wallet(s) hold no tokens.
                  </p>
                )}
                {batch.remaining > 0 && (
                  <p className={styles.helper}>
                    {batch.remaining} more sell(s) than this batch allows. Run
                    again after signing.
                  </p>
                )}
                {pending.length > 0 && (
                  <div className={styles.signBlock}>
                    <div className={styles.field}>
                      <div className={styles.fieldHead}>
                        <label htmlFor={`${field}-password`}>Vault password</label>
                      </div>
                      <div className={styles.inputContainer}>
                        <input
                          id={`${field}-password`}
                          type="password"
                          autoComplete="current-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                      </div>
                    </div>
                    <label className={styles.accept}>
                      <input
                        type="checkbox"
                        checked={accepted}
                        onChange={(e) => setAccepted(e.target.checked)}
                      />
                      <span>
                        Sign {pending.length} transaction(s) to the selected
                        buyers.
                      </span>
                    </label>
                  </div>
                )}
                <p className={styles.notice}>{summary}</p>
                {notice && <p className={styles.notice}>{notice}</p>}
                {error && (
                  <div className={styles.statusReason} role="alert">
                    {error}
                  </div>
                )}
                <div className={styles.statusButtons}>
                  {status === 'running' && (
                    <Button variant="destructive" disabled={busy} onClick={cancel}>
                      Cancel
                    </Button>
                  )}
                  <Button disabled={busy} onClick={() => setOpen(false)}>
                    Close
                  </Button>
                  {pending.length > 0 ? (
                    <Button
                      variant="secondary"
                      disabled={busy || !accepted}
                      onClick={approve}
                    >
                      {busy ? 'Working…' : 'Sign & send'}
                    </Button>
                  ) : (
                    <Button variant="secondary" disabled={busy} onClick={recover}>
                      Check outcomes
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className={styles.content}>
                <div className={styles.modeSection}>
                  <div className={styles.modeDescriptionContainer}>
                    <p className={styles.modeDescription}>
                      Sell tokens from input wallets and distribute to output
                      wallets via sell→buy rounds on the market.
                    </p>
                    <p className={styles.chainWarning}>
                      <AlertTriangle size={14} className={styles.chainWarningIcon} />
                      Token supply received is not guaranteed.
                      <br />
                      Cleanup trades can be front-run — use with caution.
                    </p>
                  </div>
                </div>
                <div className={styles.mainSection}>
                  {walletColumn('input', inputs, setInputs)}
                  {walletColumn('output', outputs, setOutputs)}
                </div>
                <div className={`${styles.section} ${styles.delaySection}`}>
                  <div className={styles.sectionHead}>
                    <div className={styles.title}>
                      <h2>Delay Between Rounds</h2>
                      <p>
                        {delayMode === 'Fixed'
                          ? 'Fixed delay between each cleanup round.'
                          : 'Random delay between each cleanup round.'}{' '}
                        (0.5s - 300s)
                      </p>
                    </div>
                    <div className={styles.segmented}>
                      <div
                        className={styles.segmentBg}
                        style={{ width: segBox.width, left: segBox.left }}
                      />
                      {(['Fixed', 'Random'] as const).map((mode, index) => (
                        <button
                          key={mode}
                          type="button"
                          ref={(el) => {
                            segRefs.current[index] = el;
                            if (el && delayMode === mode) {
                              const width = el.offsetWidth;
                              const left = el.offsetLeft;
                              setSegBox((prev) =>
                                prev.width === width && prev.left === left ? prev : { width, left },
                              );
                            }
                          }}
                          className={delayMode === mode ? styles.segmentActive : ''}
                          aria-pressed={delayMode === mode}
                          onClick={() => setDelayMode(mode)}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>
                  {delayMode === 'Fixed' ? (
                    durationField('Delay', delay, setDelay)
                  ) : (
                    <div className={styles.row}>
                      {durationField('Min Delay', delay, setDelay)}
                      {durationField('Max Delay', delayMax, setDelayMax)}
                    </div>
                  )}
                </div>
                <details
                  className={styles.advancedDetails}
                  open={advanced}
                  onToggle={(event) => setAdvanced(event.currentTarget.open)}
                >
                  <summary
                    className={styles.summary}
                    onClick={(event) => {
                      event.preventDefault();
                      setAdvanced((open) => !open);
                    }}
                  >
                    <span className={styles.summaryLabel}>
                      Advanced Options (optional)
                    </span>
                    <span className={styles.summaryLine} />
                    <ChevronDown
                      size={14}
                      className={`${styles.chevron} ${advanced ? styles.chevronOpen : ''}`}
                    />
                  </summary>
                  <div className={styles.advancedContent}>
                    <div className={styles.row}>
                      {percentField(
                        `${field}-double`,
                        'Double Buy % (optional)',
                        'Chance a round has 2 buyers.',
                        doubleBuy,
                        setDoubleBuy,
                      )}
                      {percentField(
                        `${field}-routing`,
                        'Alternative Routing (optional)',
                        'Percentage of wallets that simulate tipping activity to give the impression of trading platform usage. Cost: 0.001 SOL/wallet',
                        altRouting,
                        setAltRouting,
                      )}
                    </div>
                  </div>
                </details>
                {error && (
                  <p className={styles.error} role="alert">
                    {error}
                  </p>
                )}
                <div className={styles.buttons}>
                  <Button onClick={() => setOpen(false)}>Cancel</Button>
                  <Button
                    variant="secondary"
                    style={{ width: '25%' }}
                    disabled={busy}
                    onClick={run}
                  >
                    {busy ? 'Preparing…' : 'Run'}
                  </Button>
                </div>
              </div>
            )}

            {picker && (
              <div className={styles.pickerBackdrop}>
                <div
                  className={styles.picker}
                  role="dialog"
                  aria-modal="true"
                  aria-label={
                    picker === 'input'
                      ? 'Select Input Wallets (Sellers)'
                      : 'Select Output Wallets (Buyers)'
                  }
                >
                  <div className={styles.pickerHead}>
                    <h2>
                      {picker === 'input'
                        ? 'Select Input Wallets (Sellers)'
                        : 'Select Output Wallets (Buyers)'}
                    </h2>
                    <div className={styles.headActions}>
                      <button
                        type="button"
                        className={styles.closeButton}
                        aria-label="Close picker"
                        onClick={() => setPicker(null)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <div className={styles.searchBar}>
                    <Search size={14} className={styles.searchIcon} />
                    <Input
                      aria-label="Search wallets"
                      placeholder="Search by name or address..."
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <button
                      type="button"
                      className={styles.importWalletsButton}
                      onClick={() => router.push('/')}
                    >
                      <Download size={13} />
                      Import Wallets
                    </button>
                    <button
                      type="button"
                      className={styles.importWalletsButton}
                      onClick={() => router.push('/marketplace')}
                    >
                      <ShoppingCart size={10} />
                      Buy Wallets
                    </button>
                  </div>
                  <div className={styles.pickerTable}>
                    <div className={styles.pickerHeadRow}>
                      <label className={styles.checkboxCol}>
                        <input
                          type="checkbox"
                          aria-label="Select all wallets"
                          checked={
                            pickerWallets.length > 0 &&
                            pickerWallets.every((w) => draft.includes(w.address))
                          }
                          onChange={(e) =>
                            setDraft(
                              e.target.checked
                                ? pickerWallets
                                    .map((w) => w.address)
                                    .slice(0, CLEANUP_MAX_WALLETS)
                                : [],
                            )
                          }
                        />
                      </label>
                      {sortHead('wallet', 'Wallet')}
                      {sortHead('token', 'Token Balance', 'token')}
                      {sortHead('sol', 'SOL Balance', 'sol')}
                    </div>
                    <div className={styles.pickerRows}>
                      {sortedWallets.map((wallet) => {
                        // Proxima disables buyers that hold no SOL: they cannot pay
                        // for the buy-back leg. Skip while balances are still loading.
                        const disabled =
                          picker === 'output' &&
                          !!balances?.length &&
                          !hasSol(balances, wallet.address);
                        return (
                        <label
                          className={`${styles.pickerRow} ${disabled ? styles.pickerRowDisabled : ''}`}
                          key={wallet.address}
                        >
                          <span className={styles.checkboxCol}>
                            <input
                              type="checkbox"
                              aria-label={`Select ${wallet.label || short(wallet.address)}`}
                              disabled={disabled}
                              checked={draft.includes(wallet.address)}
                              onChange={() => toggleDraft(wallet.address)}
                            />
                          </span>
                          <span className={styles.pickerWallet}>
                            <span className={styles.walletAddress} title={wallet.address}>
                              {roleIcon(wallet.role)}
                              {wallet.label || short(wallet.address)}
                            </span>
                            <span className={styles.badge}>{wallet.role}</span>
                          </span>
                          <span className={styles.pickerBalance}>
                            {tokenBalanceOf(wallet.address)}
                          </span>
                          <span className={styles.pickerBalance}>
                            {solBalance(balances, wallet.address)}
                          </span>
                        </label>
                        );
                      })}
                      {!pickerWallets.length && (
                        <div className={styles.emptyWallets}>No wallets to display.</div>
                      )}
                    </div>
                  </div>
                  <div className={styles.pickerFooter}>
                    <Button onClick={() => setPicker(null)}>Cancel</Button>
                    <Button variant="secondary" onClick={commitPicker}>
                      Confirm ({draft.length}) -{' '}
                      {draft
                        .reduce((sum, a) => {
                          const share = shareOf(a);
                          return sum + (share === '-' ? 0 : parseFloat(share));
                        }, 0)
                        .toFixed(1)}
                      %
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
