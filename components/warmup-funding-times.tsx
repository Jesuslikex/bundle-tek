'use client';
import { walletFundingSelection } from '@/lib/wallet-funding-time';
import {
  useWalletFundingProximity,
  WalletFundingProximityBadge,
  WalletFundingProximityPanel,
} from './wallet-funding-proximity';

/** Advisory reads only. Never supplies evidence to plan/consent/signing. */
export function WarmupFundingTimes({
  addresses,
  walletRevisions,
}: {
  addresses: string[];
  walletRevisions: { address: string; revision: number }[];
}) {
  const exactRoster =
    addresses.length <= 20 &&
    walletRevisions.length === addresses.length &&
    new Set(walletRevisions.map((w) => w.address)).size === addresses.length;
  const parsed = walletFundingSelection.safeParse({
    wallets: exactRoster
      ? addresses.map((address) => ({
          address,
          revision: walletRevisions.find((w) => w.address === address)
            ?.revision,
        }))
      : [],
  });
  const check = useWalletFundingProximity(
    parsed.success ? parsed.data.wallets : [],
  );
  return (
    <div>
      <h4>Compare funding times</h4>
      <p>
        Check whether these warmup wallets have funding events close together.
        This read does not change your plan, routing or approval. Timing alone
        does not establish shared ownership.
      </p>
      {parsed.success ? (
        <>
          <WalletFundingProximityPanel
            check={check}
            count={parsed.data.wallets.length}
            context="warmup"
          />
          {check.result && (
            <ul aria-label="Warmup funding observations">
              {parsed.data.wallets.map(({ address }) => (
                <li key={address}>
                  <code className="warmup-address">{address}</code>
                  <WalletFundingProximityBadge
                    check={check}
                    address={address}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <output>
          Reopen warmup with 1 to 20 current Solana wallets to compare their
          funding times. The exact wallet revisions are unavailable.
        </output>
      )}
    </div>
  );
}
