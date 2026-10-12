'use client';
import { useId, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  sizeTradeSession,
  summarizeSessionAmounts,
} from '@/lib/trade-session-sizing';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
export function TradeSessionSizing({
  amounts,
  decimals,
  currency,
  disabled,
  onApply,
}: {
  amounts: string[];
  decimals: number;
  currency: string;
  disabled: boolean;
  onApply: (amounts: string[]) => void;
}) {
  const [mode, setMode] = useState<'total' | 'each'>('total');
  const [amount, setAmount] = useState('');
  const inputId = useId();
  let proposal: ReturnType<typeof sizeTradeSession> | null = null,
    error = '';
  if (amount)
    try {
      proposal = sizeTradeSession(mode, amount, amounts.length, decimals);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Invalid session sizing.';
    }
  const summary = summarizeSessionAmounts(amounts, decimals);
  return (
    <section
      className="space-y-2 rounded-md border p-3"
      aria-label="Session amount sizing"
    >
      <h5>Size selected wallets</h5>
      <label>
        Allocation method{' '}
        <select
          aria-label="Session allocation method"
          value={mode}
          disabled={disabled}
          onChange={(e) => setMode(e.target.value as 'total' | 'each')}
        >
          <option value="total">Split a total input equally</option>
          <option value="each">Same input for every wallet</option>
        </select>
      </label>
      <label htmlFor={inputId}>
        {mode === 'total' ? 'Total input budget' : 'Input per wallet'} (
        {currency})
      </label>
      <Input
        id={inputId}
        value={amount}
        disabled={disabled}
        inputMode="decimal"
        maxLength={277}
        onChange={(e) => setAmount(e.target.value)}
      />
      {proposal && (
        <output style={{ display: 'block' }}>
          Preview: {amounts.length} wallets;{' '}
          {formatNativeBalance(proposal.totalRaw, decimals)} {currency} total.{' '}
          {mode === 'total'
            ? proposal.remainderWallets === 0
              ? 'The budget divides evenly without a remainder.'
              : `${proposal.remainderWallets} ${proposal.remainderWallets === 1 ? 'first entry receives' : 'first entries receive'} one extra atomic unit to preserve the exact total.`
            : 'Every entry receives the same exact input.'}
        </output>
      )}
      {error && <p role="alert">{error}</p>}
      <Button
        variant="outline"
        disabled={disabled || !proposal}
        onClick={() => {
          if (proposal) onApply(proposal.amounts);
        }}
      >
        Apply amounts to selected wallets
      </Button>
      <output style={{ display: 'block' }}>
        {summary
          ? `Current entries: ${amounts.length} wallets; ${summary.total} ${currency} total input (${summary.totalRaw} atomic units).`
          : 'Enter valid positive amounts for every selected wallet to review the total.'}
      </output>
      <p>
        Applying replaces the editable amounts below. Fees and wallet reserves
        are additional. Saving a session preserves these exact inputs; each
        wallet still needs fresh balance checks and its own signing approval.
      </p>
    </section>
  );
}
