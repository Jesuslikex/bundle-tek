'use client';
import { createContext } from 'react';
import type { CartReview } from '@/lib/marketplace-cart';
export const MarketplaceReservationContext = createContext<{
  open: (review: CartReview) => void;
  version: number;
} | null>(null);
