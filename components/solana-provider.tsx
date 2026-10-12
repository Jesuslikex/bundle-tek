'use client';

import { useMemo, type ReactNode } from 'react';
import { ClientProvider, useClient } from '@solana/react';
import { createAppClient, type AppClient } from '@/lib/solana-client';
import { VaultExecutionProvider } from './vault-execution-provider';

export function SolanaProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => createAppClient(), []);
  return (
    <ClientProvider client={client}>
      <VaultExecutionProvider>{children}</VaultExecutionProvider>
    </ClientProvider>
  );
}

export function useAppClient() {
  return useClient<AppClient>();
}
