'use client';

import { useLayoutEffect, useMemo } from 'react';
import { DevnetIntentScope } from '@/lib/devnet-intent';

export function useDevnetIntent(identity: string | null) {
  const scope = useMemo(() => new DevnetIntentScope(), []);
  useLayoutEffect(() => {
    scope.invalidate();
    return () => scope.invalidate();
  }, [scope, identity]);
  return scope;
}
