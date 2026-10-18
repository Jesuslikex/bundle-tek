'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { exchangeUiRequest } from '@/lib/exchange-ui-request';
import { readWorkspaceResponse } from '@/lib/workspace-response';
import { exchangeRefundAddress } from '@/lib/exchange-order-review';
import {
  exchangeSolDisplay,
  type ExchangeFundingReview,
} from '@/lib/exchange-funding-review';
import {
  decodeExchangeOrderHistoryDetail,
  type ExchangeOrderHistoryDetail,
} from '@/lib/exchange-order-history';
import styles from './exchange-order-review.module.css';

const endpoint = '/api/funding/exchange-order-review';
const roster = z.object({
  wallets: z
    .array(
      z.object({
        chain: z.string(),
        address: z.string().max(100),
        label: z.string().max(100),
        revision: z.number().int().min(1).max(1e9),
        archived: z.boolean(),
      }),
    )
    .max(500),
  proofs: z
    .array(z.object({ chain: z.string(), address: z.string().max(100) }))
    .max(500),
});
type Wallet = { address: string; revision: number; label: string };
export function ExchangeOrderReview(props: {
  quote: ExchangeFundingReview;
  blockedReason?: string;
}) {
  return <Review key={JSON.stringify(props)} {...props} />;
}
function Review({
  quote,
  blockedReason = '',
}: {
  quote: ExchangeFundingReview;
  blockedReason?: string;
}) {
  const id = useId(),
    generation = useRef(0),
    pending = useRef<AbortController | null>(null),
    active = useRef(false);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(''),
    [options, setOptions] = useState<Wallet[]>([]),
    [selected, setSelected] = useState(''),
    [saved, setSaved] = useState<ExchangeOrderHistoryDetail | null>(null),
    [loaded, setLoaded] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [clock, setClock] = useState(Date.now),
    [controllers] = useState(() => new Set<AbortController>());
  const invalidate = useCallback(() => {
    generation.current++;
    controllers.forEach((controller) => controller.abort());
  }, [controllers]);
  useEffect(() => {
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.max(
        0,
        Math.min(2147483647, Date.parse(quote.expiresAt) - 5000 - Date.now()),
      ),
    );
    return () => {
      clearTimeout(timer);
      invalidate();
    };
  }, [quote.expiresAt, invalidate]);
  const fresh = Date.parse(quote.expiresAt) > clock + 5000;
  function decode(value: unknown) {
    const detail = decodeExchangeOrderHistoryDetail(value);
    if (
      detail.quote.id !== quote.id ||
      JSON.stringify(detail.quote) !== JSON.stringify(quote)
    )
      throw Error('Saved review context differs.');
    return detail;
  }
  async function load() {
    if (active.current) return;
    active.current = true;
    pending.current?.abort();
    const controller = new AbortController(),
      mine = ++generation.current;
    pending.current = controller;
    controllers.add(controller);
    setBusy('Loading saved review and proven refund wallets…');
    setError('');
    setNotice('');
    setLoaded(false);
    let signedOut = false;
    try {
      const [reviewResult, walletResult] = await exchangeUiRequest(
        controller.signal,
        async (signal) => {
          const get = async (url: string) => {
            const response = await fetch(url, { cache: 'no-store', signal });
            signal.throwIfAborted();
            if (response.status === 401) signedOut = true;
            return readWorkspaceResponse(
              response,
              'Saved review or wallet choices are unavailable. Reload to try again.',
              'Sign in to review refund wallets.',
            );
          };
          return Promise.allSettled([
            get(endpoint + '?quoteId=' + encodeURIComponent(quote.id)),
            get('/api/wallet-workspace'),
          ]);
        },
      );
      if (controller.signal.aborted || mine !== generation.current) return;
      if (signedOut) {
        setSaved(null);
        setOptions([]);
        setSelected('');
        throw Error('Sign in');
      }
      if (reviewResult.status !== 'fulfilled')
        throw Error('Recovery unavailable');
      const retained =
        reviewResult.value.order === null
          ? null
          : decode(reviewResult.value.order);
      setSaved(retained);
      setUncertain(false);
      if (retained) {
        setNotice(
          'Saved review recovered. Changing its refund wallet requires a fresh quote.',
        );
        setSelected(retained.refundAddress);
      }
      if (walletResult.status === 'fulfilled') {
        const workspace = roster.parse(walletResult.value),
          wallets = workspace.wallets.filter((w) => w.chain === 'Solana');
        if (new Set(wallets.map((w) => w.address)).size !== wallets.length)
          throw Error('Duplicate wallet');
        for (const wallet of wallets) exchangeRefundAddress(wallet.address);
        const proven = (address: string) =>
          workspace.proofs.some(
            (p) => p.chain === 'Solana' && p.address === address,
          );
        const funder = wallets.find(
          (w) =>
            w.address === quote.funder &&
            !w.archived &&
            w.revision === quote.funderRevision &&
            proven(w.address),
        );
        const choices = wallets.filter(
          (w) => !w.archived && w.address !== quote.funder && proven(w.address),
        );
        setOptions(funder ? choices : []);
        if (!funder)
          setNotice(
            'The receiving funder needs a current saved ownership proof. Review it in Wallets, then reload.',
          );
        if (!retained)
          setSelected((current) =>
            choices.some((w) => w.address === current) ? current : '',
          );
        setLoaded(Boolean(funder));
      } else {
        setOptions([]);
        setNotice(
          'Refund wallet choices are unavailable. Saved review recovery is still shown; reload to choose a wallet.',
        );
      }
    } catch {
      if (!controller.signal.aborted && mine === generation.current) {
        if (signedOut) {
          setSaved(null);
          setOptions([]);
          setSelected('');
          setLoaded(false);
        }
        setError(
          signedOut
            ? 'Sign in to review refund wallets.'
            : 'Saved review or wallet choices are unavailable or inconsistent. Reload before saving.',
        );
      }
    } finally {
      controllers.delete(controller);
      if (mine === generation.current) {
        active.current = false;
        setBusy('');
      }
    }
  }
  async function save() {
    const wallet = options.find((w) => w.address === selected);
    if (
      active.current ||
      !wallet ||
      !loaded ||
      uncertain ||
      saved ||
      blockedReason ||
      Date.parse(quote.expiresAt) <= Date.now() + 5000
    )
      return;
    active.current = true;
    pending.current?.abort();
    const controller = new AbortController(),
      mine = ++generation.current;
    pending.current = controller;
    controllers.add(controller);
    setUncertain(true);
    setBusy('Saving the exact quote and refund review…');
    setError('');
    setNotice('');
    let signedOut = false;
    try {
      const body = await exchangeUiRequest(
        controller.signal,
        async (signal) => {
          const response = await fetch(endpoint, {
            method: 'POST',
            cache: 'no-store',
            signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              quoteId: quote.id,
              refund: { address: wallet.address, revision: wallet.revision },
            }),
          });
          signal.throwIfAborted();
          signedOut = response.status === 401;
          return readWorkspaceResponse(
            response,
            'Save result could not be confirmed. Reload saved review before another attempt.',
            'Sign in to recover the saved review.',
          );
        },
      );
      if (controller.signal.aborted || mine !== generation.current) return;
      const retained = decode(body.order);
      if (retained.refundAddress !== wallet.address)
        throw Error('Refund differs');
      setSaved(retained);
      setUncertain(false);
      setNotice(
        'Review saved. No exchange order, deposit or approval was created. Reload Saved exchange orders below to read it again.',
      );
    } catch {
      if (!controller.signal.aborted && mine === generation.current) {
        if (signedOut) {
          setOptions([]);
          setSaved(null);
          setSelected('');
          setLoaded(false);
        }
        setError(
          signedOut
            ? 'Sign in to recover the saved review.'
            : 'Save result could not be confirmed. A review may already exist. Reload saved review before another attempt.',
        );
      }
    } finally {
      controllers.delete(controller);
      if (mine === generation.current) {
        active.current = false;
        setBusy('');
      }
    }
  }
  const reason =
    blockedReason ||
    (!fresh
      ? 'This quote is expired or too close to expiry. Request a fresh quote before saving a new review.'
      : !loaded
        ? 'Load current proven wallet choices before saving.'
        : !options.length
          ? 'Add and prove a separate Solana refund wallet in Wallets, then reload.'
          : !selected
            ? 'Choose a separate refund wallet.'
            : uncertain
              ? 'Recover the saved review before another attempt.'
              : '');
  return (
    <section className={styles.panel} aria-label="Quote and refund review">
      <h4>Quote and refund review</h4>
      <p>
        Save the quote and a separate proven refund wallet before any exchange
        order. Saving this review does not approve or create an order.
      </p>
      {!open && blockedReason && <p>{blockedReason}</p>}
      {!open ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOpen(true);
            void load();
          }}
        >
          Review refund wallet
        </Button>
      ) : (
        <>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => void load()}
            >
              Reload saved review and wallets
            </Button>
          </div>
          {busy && (
            <>
              <output>{busy}</output>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  generation.current++;
                  pending.current?.abort();
                  active.current = false;
                  setBusy('');
                  setError(
                    uncertain
                      ? 'Stopped waiting. A review may already be saved. Reload before trying again.'
                      : 'Loading stopped. Reload saved review and wallets to continue.',
                  );
                }}
              >
                Stop waiting for review
              </Button>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          {notice && <output>{notice}</output>}
          {!saved && (
            <>
              <label htmlFor={id}>Separate refund wallet</label>
              <select
                id={id}
                disabled={Boolean(busy) || uncertain || !loaded}
                value={selected}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setError('');
                }}
              >
                <option value="">Choose a proven wallet</option>
                {options.map((w) => (
                  <option key={w.address} value={w.address}>
                    {w.label || 'Wallet'} · {w.address}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                disabled={Boolean(busy) || Boolean(reason)}
                aria-describedby={id + '-reason'}
                onClick={() => void save()}
              >
                Save quote and refund review
              </Button>
              <p id={id + '-reason'}>
                {reason ||
                  'The server rechecks ownership proofs, wallet revisions and the current funding draft before saving.'}
              </p>
            </>
          )}
          <dl>
            {[
              ['Network', 'Solana Mainnet'],
              [
                'Provider deposit cost',
                exchangeSolDisplay(quote.depositLamports) + ' SOL',
              ],
              [
                'Expected payout',
                exchangeSolDisplay(quote.expectedPayoutLamports) + ' SOL',
              ],
              [
                'Provider cost included',
                exchangeSolDisplay(quote.providerCostLamports) + ' SOL',
              ],
              ['Receiving funder', quote.funder],
              [
                'Refund wallet',
                saved?.refundAddress || selected || 'Not selected',
              ],
              ['Quote expiry', new Date(quote.expiresAt).toLocaleString()],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {saved && (
            <p>
              Saved review {saved.id}. This is retained review evidence; it does
              not authorize an order, deposit, signature or distribution.
            </p>
          )}
          <p>
            Provider order creation and deposits remain unavailable here. Any
            future order requires separate approval of the exact saved terms.
          </p>
        </>
      )}
    </section>
  );
}
