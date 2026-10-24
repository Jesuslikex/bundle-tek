'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  unlockVault,
  VAULT_STORAGE_KEY,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import {
  ORDER_ACK,
  orderDeliveryKeys,
  signOrderPayment,
  type MarketplaceOrder,
} from '@/lib/marketplace-order';
import type { ReservationRecord } from '@/lib/marketplace-reservation';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import styles from './marketplace-reservation-buyer.module.css';

const sol = (lamports: string) => formatNativeBalance(lamports, 9) + ' SOL';
export const CHECKOUT_POLL_MS = 4000;
const orderKey = (reservationId: string) =>
  `bundle:marketplace-order:${reservationId}`;

export async function orderRequest(body?: object, signal?: AbortSignal) {
  const response = await fetch('/api/marketplace/orders', {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
    cache: 'no-store',
  });
  const value = (await response.json().catch(() => ({}))) as {
    error?: string;
    order?: MarketplaceOrder;
    orders?: MarketplaceOrder[];
  };
  if (!response.ok) throw new Error(value.error || 'Checkout unavailable.');
  return value;
}
export function wipeSession(session: VaultSession | null) {
  if (!session) return;
  session.payload.wallets.forEach((w) => {
    w.seed = '';
  });
  session.payload.wallets.length = 0;
}
function savedOrderId(reservationId: string) {
  try {
    const saved = localStorage.getItem(orderKey(reservationId));
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(orderKey(reservationId), id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** Pays one held reservation: one exact SOL transfer, signed here and sent once. */
export function MarketplaceCheckout({
  reservation,
}: {
  reservation: ReservationRecord;
}) {
  const field = useId();
  const [password, setPassword] = useState('');
  const [wallets, setWallets] = useState<string[] | null>(null);
  const [payer, setPayer] = useState('');
  const [consent, setConsent] = useState(false);
  const [payConsent, setPayConsent] = useState(false);
  const [order, setOrder] = useState<MarketplaceOrder | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const session = useRef<VaultSession | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      wipeSession(session.current);
      session.current = null;
    },
    [],
  );
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Checkout failed.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const unlock = () =>
    run(async () => {
      const pass = password;
      setPassword('');
      const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
      if (!encrypted)
        throw new Error('Create or import your wallet vault first.');
      wipeSession(session.current);
      session.current = await unlockVault(encrypted, pass);
      setUnlocked(true);
      const list = session.current.payload.wallets
        .filter((w) => w.family === 'solana')
        .map((w) => w.address);
      setWallets(list);
      setPayer(list[0] ?? '');
    });
  const create = () =>
    run(async () => {
      if (!session.current) throw new Error('Unlock your vault first.');
      const id = savedOrderId(reservation.id);
      const keys = orderDeliveryKeys(session.current, payer, id);
      keys.secretKey.fill(0);
      const value = await orderRequest({
        action: 'create',
        id,
        reservationId: reservation.id,
        reservationSha256: reservation.contextSha256,
        buyerWallet: payer,
        deliveryPublicKey: keys.publicKey,
        acknowledgement: ORDER_ACK,
      });
      if (alive.current) setOrder(value.order!);
    });
  const pay = () =>
    run(async () => {
      if (!order || !session.current)
        throw new Error('Unlock your vault first.');
      const signed = await signOrderPayment(
        session.current,
        order.document,
        () => {
          if (!alive.current) throw new Error('Checkout closed.');
        },
      );
      wipeSession(session.current);
      session.current = null;
      setUnlocked(false);
      setPayConsent(false);
      await orderRequest({
        action: 'register',
        id: order.document.id,
        transaction: signed.transaction,
      });
      const sent = await orderRequest({
        action: 'submit',
        id: order.document.id,
      });
      if (alive.current) setOrder(sent.order!);
    });
  const state = order?.state;
  useEffect(() => {
    if (state !== 'submitted' || !order) return;
    let stopped = false;
    const timer = setInterval(() => {
      orderRequest({ action: 'recover', id: order.document.id })
        .then((value) => {
          if (!stopped && value.order) setOrder(value.order);
        })
        .catch(() => undefined);
    }, CHECKOUT_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [state, order]);

  const expired = order ? Date.parse(order.document.expiresAt) <= now : false;
  return (
    <section aria-label="Checkout" className={styles.panel}>
      <h4>Check out</h4>
      {!order && (
        <>
          <p>
            Pay {sol(reservation.review.askingPriceLamports)} for{' '}
            {reservation.review.count} wallet
            {reservation.review.count === 1 ? '' : 's'} in one SOL transfer from
            a verified wallet in your vault. The payment is signed here and sent
            once.
          </p>
          {!wallets ? (
            <>
              <label htmlFor={field + '-pass'}>
                Wallet vault passphrase
                <input
                  id={field + '-pass'}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <div className={styles.controls}>
                <button
                  disabled={busy || !password}
                  onClick={() => void unlock()}
                >
                  Unlock to check out
                </button>
              </div>
            </>
          ) : (
            <>
              <label htmlFor={field + '-payer'}>
                Pay from
                <select
                  id={field + '-payer'}
                  value={payer}
                  disabled={busy}
                  onChange={(e) => setPayer(e.target.value)}
                >
                  {wallets.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.ack}>
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>{ORDER_ACK}</span>
              </label>
              <div className={styles.controls}>
                <button
                  disabled={busy || !consent || !payer}
                  onClick={() => void create()}
                >
                  Review payment
                </button>
              </div>
            </>
          )}
        </>
      )}
      {order && (
        <>
          <dl className={styles.facts}>
            <div>
              <dt>Amount</dt>
              <dd>{sol(order.document.amountLamports)}</dd>
            </div>
            <div>
              <dt>From</dt>
              <dd>
                <code>{order.document.buyerWallet}</code>
              </dd>
            </div>
            <div>
              <dt>To (Bundle)</dt>
              <dd>
                <code>{order.document.payoutAddress}</code>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{order.state.replace('_', ' ')}</dd>
            </div>
          </dl>
          {order.state === 'awaiting_payment' && (
            <>
              <p>
                {expired
                  ? 'This payment review expired. Release the hold and reserve again.'
                  : `Pay before ${new Date(order.document.expiresAt).toLocaleTimeString()}.`}
              </p>
              <label className={styles.ack}>
                <input
                  type="checkbox"
                  checked={payConsent}
                  disabled={busy || expired}
                  onChange={(e) => setPayConsent(e.target.checked)}
                />
                <span>
                  I approve sending exactly {sol(order.document.amountLamports)}{' '}
                  to Bundle once.
                </span>
              </label>
              <div className={styles.controls}>
                <button
                  disabled={busy || !payConsent || expired || !unlocked}
                  onClick={() => void pay()}
                >
                  Sign and pay once
                </button>
              </div>
              {!unlocked && (
                <p>Unlock your vault again to sign this payment.</p>
              )}
            </>
          )}
          {order.state === 'signed' && (
            <div className={styles.controls}>
              <button
                disabled={busy || expired}
                onClick={() =>
                  void run(async () => {
                    const sent = await orderRequest({
                      action: 'submit',
                      id: order.document.id,
                    });
                    if (alive.current) setOrder(sent.order!);
                  })
                }
              >
                Send the signed payment once
              </button>
            </div>
          )}
          {order.state === 'submitted' && (
            <output>Payment sent. Waiting for it to finalize…</output>
          )}
          {order.state === 'paid' && (
            <output>
              Paid. Bundle now delivers the wallet keys encrypted to you; open
              My orders to import them.
            </output>
          )}
          {order.state === 'failed' && (
            <p role="alert">
              The payment did not land, so nothing was charged beyond any
              network fee. Reserve again to retry.
            </p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
