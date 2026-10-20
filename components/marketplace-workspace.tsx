'use client';
import { useState } from 'react';
import { MarketplacePanel } from './marketplace-panel';
import { MarketplaceOwnedWallets } from './marketplace-owned-wallets';
import styles from './marketplace-owned-wallets.module.css';
export function MarketplaceWorkspace() {
  const [section, setSection] = useState<'catalog' | 'owned'>('catalog');
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
          aria-pressed={section === 'owned'}
          onClick={() => setSection('owned')}
        >
          My inventory
        </button>
      </nav>
      {section === 'catalog' ? (
        <MarketplacePanel />
      ) : (
        <MarketplaceOwnedWallets />
      )}
    </>
  );
}
