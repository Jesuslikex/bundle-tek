'use client';

import { Button } from '@/components/ui/button';
import { useFunderAddress } from '@/components/sidebar-funder';
import type { LaunchChain } from '@/lib/launch-plan';

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

/**
 * Proxima-style Funding Wallet / Auto Sell / Sniper Guard row at the top of
 * Launch Settings. It only links to existing reviewed flows; nothing here
 * signs, funds or arms anything.
 */
export function LaunchWorkspacePanels({
  chain,
  onFund,
  onOpenWallets,
}: {
  chain: LaunchChain;
  onFund: () => void;
  onOpenWallets: () => void;
}) {
  const funder = useFunderAddress(chain);
  return (
    <div className="launch-ws-panels">
      <section aria-labelledby="ws-funding-title">
        <h2 id="ws-funding-title">Funding Wallet</h2>
        {funder ? (
          <code className="launch-ws-funder" title={funder}>
            {short(funder)}
          </code>
        ) : (
          <p>Pick a funder in the sidebar.</p>
        )}
        <div className="launch-ws-panel-actions">
          <Button variant="outline" onClick={onFund}>
            Fund wallets
          </Button>
          <Button variant="outline" onClick={onOpenWallets}>
            My wallets
          </Button>
        </div>
      </section>
      <section aria-labelledby="ws-autosell-title">
        <h2 id="ws-autosell-title">Auto Sell</h2>
        <p className="launch-ws-empty">
          After launch, open the token workspace and press Auto Sell. Run
          Strategy sells a set % of every outside buy while that tab is open.
        </p>
      </section>
      <section aria-labelledby="ws-sniper-title">
        <h2 id="ws-sniper-title">Sniper Guard</h2>
        <p className="launch-ws-empty">
          Configured in the launch review before you sign. It watches for
          outside buyers and offers a Nuke or early finish.
        </p>
      </section>
      <section aria-labelledby="ws-cleanup-title">
        <h2 id="ws-cleanup-title">Cleanup</h2>
        <p className="launch-ws-empty">
          Sell tokens from input wallets and distribute to output wallets via
          sell→buy rounds on the market. Rounds run on a fixed or random delay.
        </p>
        <div className="launch-ws-panel-actions">
          <Button variant="outline" onClick={onOpenWallets}>
            Configure
          </Button>
        </div>
      </section>
    </div>
  );
}
