'use client';
import { useState } from 'react';
import {
  readTemporaryHolders,
  saveTemporaryHolders,
} from '@/lib/temporary-holders';

export function TemporaryHoldersPicker({
  mint,
  holders,
  disabled,
}: {
  mint: string;
  holders: string[];
  disabled?: boolean;
}) {
  const [chosen, setChosen] = useState(() =>
    readTemporaryHolders(mint).filter((w) => holders.includes(w)),
  );
  if (!holders.length) return null;
  return (
    <fieldset className="min-w-0 space-y-1 break-words">
      <legend>Block-0 temporary holders</legend>
      <p className="text-xs text-muted-foreground">
        Mark holder wallets you plan to sell back after launch. Opening the
        token workspace prefills a Sell session with them. Each sell still needs
        its own review, approval and signature.
      </p>
      {holders.map((address) => (
        <label key={address} className="flex items-center gap-2">
          <input
            type="checkbox"
            disabled={disabled}
            checked={chosen.includes(address)}
            onChange={(e) =>
              setChosen(
                saveTemporaryHolders(
                  mint,
                  e.target.checked
                    ? [...chosen, address]
                    : chosen.filter((w) => w !== address),
                ),
              )
            }
          />
          <span className="min-w-0 break-all">{address}</span>
        </label>
      ))}
    </fieldset>
  );
}
