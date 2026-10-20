'use client';
import { useState } from 'react';
import { MarketplacePanel } from './marketplace-panel';
import { MarketplaceOwnedWallets } from './marketplace-owned-wallets';
import { MarketplaceOperatorConsole } from './marketplace-operator-console';
import styles from './marketplace-owned-wallets.module.css';
export function MarketplaceWorkspace() {
  const [section, setSection] = useState<'catalog' | 'owned' | 'operator'>(
    'catalog',
  );
  return (
    <>
      <nav className={styles.navigation} aria-label="Marketplace sections">
        <button
          aria-pressed={section === 'catalog'}
          onClick={() => setSection('catalog')}
        >
          Browse wallets
        </button>
        <button
          aria-pressed={section === 'operator'}
          onClick={() => setSection('operator')}
        >
          Seller console
        </button>
        <button
          aria-pressed={section === 'owned'}
          onClick={() => setSection('owned')}
        >
          My inventory
        </button>
      </nav>
      {section === 'catalog' ? (
        <MarketplacePanel />
      ) : section === 'owned' ? (
        <MarketplaceOwnedWallets />
      ) : (
        <MarketplaceOperatorConsole />
      )}
    </>
  );
}
