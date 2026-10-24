'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  encryptVault,
  importVaultWallets,
  saveBrowserVault,
  unlockVault,
  VAULT_STORAGE_KEY,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import {
  openOrderDelivery,
  orderDeliveryKeys,
  sealOrderDelivery,
  type MarketplaceOrder,
} from '@/lib/marketplace-order';
import type { PendingDelivery } from '@/lib/marketplace-order-storage';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { orderRequest, wipeSession } from './marketplace-checkout';
import styles from './marketplace-reservation-buyer.module.css';

const sol = (lamports: string) => formatNativeBalance(lamports, 9) + ' SOL';
const short = (a: string) => a.slice(0, 4) + '…' + a.slice(-4);

function usePassphrase() {
  const [value, setValue] = useState('');
  const take = () => {
    const pass = value;
    setValue('');
    return pass;
  };
  return { value, setValue, take };
}
async function unlock(pass: string) {
  const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
  if (!encrypted) throw new Error('Create or import your wallet vault first.');
  return { encrypted, session: await unlockVault(encrypted, pass) };
}

/** Buyer order history: payment status and import of delivered wallet keys. */
export function MarketplaceOrders() {
  const field = useId();
  const [orders, setOrders] = useState<MarketplaceOrder[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pass = usePassphrase();
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const load = useCallback(async () => {
    const value = await orderRequest();
    if (alive.current) setOrders(value.orders ?? []);
  }, []);
  useEffect(() => {
    load().catch((e) =>
      setError(e instanceof Error ? e.message : 'Orders unavailable.'),
    );
  }, [load]);
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Order action failed.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const importKeys = (order: MarketplaceOrder) =>
    run(async () => {
      let session: VaultSession | null = null;
      try {
        const opened = await unlock(pass.take());
        session = opened.session;
        const keys = orderDeliveryKeys(
          session,
          order.document.buyerWallet,
          order.document.id,
        );
        let lines: string[];
        try {
          lines = order.deliveries.map((d) =>
            openOrderDelivery(d, keys.secretKey),
          );
        } finally {
          keys.secretKey.fill(0);
        }
        const result = importVaultWallets(session, 'solana', lines.join('\n'));
        lines.length = 0;
        const next = await encryptVault(result.session);
        await saveBrowserVault(opened.encrypted, next, () => alive.current);
        wipeSession(result.session);
        if (alive.current)
          setNotice(
            `${result.added} wallet${result.added === 1 ? '' : 's'} added to your vault${result.skipped ? `, ${result.skipped} already there` : ''}. Add them to My wallets to trade.`,
          );
      } finally {
        wipeSession(session);
      }
    });

  return (
    <section aria-label="My orders" className={styles.panel}>
      <h3>My orders</h3>
      {!orders && !error && <p>Loading orders…</p>}
      {orders && !orders.length && <p>No marketplace orders yet.</p>}
      {orders?.map((order) => {
        const total = order.document.addresses.length;
        const delivered = order.deliveries.length;
        return (
          <article key={order.document.id} className={styles.facts}>
            <p>
              {total} wallet{total === 1 ? '' : 's'} for{' '}
              {sol(order.document.amountLamports)} ·{' '}
              {order.state.replace('_', ' ')}
              {order.state === 'paid' &&
                ` · ${delivered} of ${total} delivered`}
            </p>
            {order.signature && (
              <p>
                <a
                  href={`https://solscan.io/tx/${order.signature}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Payment {short(order.signature)}
                </a>
              </p>
            )}
            {order.state === 'submitted' && (
              <div className={styles.controls}>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await orderRequest({
                        action: 'recover',
                        id: order.document.id,
                      });
                      await load();
                    })
                  }
                >
                  Check payment
                </button>
              </div>
            )}
            {order.state === 'paid' && delivered > 0 && (
              <div className={styles.controls}>
                <button
                  disabled={busy || !pass.value}
                  onClick={() => void importKeys(order)}
                >
                  Import {delivered} delivered wallet
                  {delivered === 1 ? '' : 's'} into my vault
                </button>
              </div>
            )}
          </article>
        );
      })}
      {orders?.some((o) => o.state === 'paid' && o.deliveries.length) && (
        <label htmlFor={field + '-pass'}>
          Wallet vault passphrase (to open deliveries)
          <input
            id={field + '-pass'}
            type="password"
            autoComplete="current-password"
            value={pass.value}
            disabled={busy}
            onChange={(e) => pass.setValue(e.target.value)}
          />
        </label>
      )}
      <div className={styles.controls}>
        <button disabled={busy} onClick={() => void run(load)}>
          Refresh orders
        </button>
      </div>
      {notice && <output>{notice}</output>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** Seller side: encrypt each paid wallet's key to its buyer and upload only ciphertext. */
export function MarketplaceDeliveries() {
  const field = useId();
  const [pending, setPending] = useState<PendingDelivery[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pass = usePassphrase();
  const load = useCallback(async () => {
    const response = await fetch('/api/marketplace/orders?deliveries=1', {
      cache: 'no-store',
    });
    const value = (await response.json().catch(() => ({}))) as {
      error?: string;
      pending?: PendingDelivery[];
    };
    if (!response.ok) throw new Error(value.error || 'Deliveries unavailable.');
    return value.pending ?? [];
  }, []);
  useEffect(() => {
    load().then(setPending, (e: unknown) =>
      setError(e instanceof Error ? e.message : 'Deliveries unavailable.'),
    );
  }, [load]);
  const deliver = (item: PendingDelivery) => {
    setBusy(true);
    setError('');
    setNotice('');
    void (async () => {
      let session: VaultSession | null = null;
      try {
        session = (await unlock(pass.take())).session;
        const deliveries = item.addresses.map((address) =>
          sealOrderDelivery(session!, address, item.deliveryPublicKey),
        );
        const response = await fetch('/api/marketplace/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'deliver',
            id: item.orderId,
            deliveries,
          }),
        });
        const value = (await response.json().catch(() => ({}))) as {
          error?: string;
          pending?: PendingDelivery[];
        };
        if (!response.ok) throw new Error(value.error || 'Delivery failed.');
        setPending(value.pending ?? []);
        setNotice(
          `Delivered ${deliveries.length} encrypted key${deliveries.length === 1 ? '' : 's'}.`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Delivery failed.');
      } finally {
        wipeSession(session);
        setBusy(false);
      }
    })();
  };
  return (
    <section aria-label="Deliveries" className={styles.panel}>
      <h3>Paid orders to deliver</h3>
      <p>
        Each wallet&apos;s key is encrypted in this browser to the buyer&apos;s
        delivery key. Bundle stores only the encrypted copy.
      </p>
      {!pending && !error && <p>Loading…</p>}
      {pending && !pending.length && <p>Nothing to deliver.</p>}
      {pending && pending.length > 0 && (
        <label htmlFor={field + '-pass'}>
          Wallet vault passphrase (holds the sold wallets)
          <input
            id={field + '-pass'}
            type="password"
            autoComplete="current-password"
            value={pass.value}
            disabled={busy}
            onChange={(e) => pass.setValue(e.target.value)}
          />
        </label>
      )}
      {pending?.map((item) => (
        <article key={item.orderId} className={styles.facts}>
          <p>
            Paid {new Date(item.paidAt).toLocaleString()} ·{' '}
            {item.addresses.length} wallet
            {item.addresses.length === 1 ? '' : 's'}:{' '}
            {item.addresses.map(short).join(', ')}
          </p>
          <div className={styles.controls}>
            <button
              disabled={busy || !pass.value}
              onClick={() => deliver(item)}
            >
              Deliver encrypted keys
            </button>
          </div>
        </article>
      ))}
      {notice && <output>{notice}</output>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
