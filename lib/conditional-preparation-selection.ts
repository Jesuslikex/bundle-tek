import {
  decodeConditionalOrder,
  conditionalOrderSide,
  CONDITIONAL_BUY_INPUT_MINT,
  type ConditionalOrder,
} from './conditional-order';
import { validatedConditionalSigning } from './conditional-signing';
import type { ConditionalLevelRequest } from './conditional-preparation-server';

export async function requireSelectedConditionalPreparation(
  value: unknown,
  selection: ConditionalLevelRequest,
  retained: ConditionalOrder | undefined,
  context: {
    projectId: string;
    projectRevision: number;
    wallet: string;
    walletRevision: number;
    mint: string;
    decimals: number;
    side: string;
    unitsRaw: string;
  },
  now = Date.now(),
) {
  if (!retained)
    throw new Error('Selected saved conditional order unavailable.');
  const order = decodeConditionalOrder(retained);
  const terms = order.terms;
  const level = terms.levels.find((item) => item.level === selection.level);
  const capture = validatedConditionalSigning(value, context.unitsRaw, now);
  if (
    order.state !== 'draft' ||
    order.id !== selection.orderId ||
    order.revision !== selection.revision ||
    !level ||
    context.side !== conditionalOrderSide(order) ||
    (context.side === 'Buy' &&
      (capture.format !== 'conditional-preparation-v2' ||
        capture.outputMint !== terms.mint ||
        capture.outputDecimals !== terms.decimals ||
        capture.inputMint !== CONDITIONAL_BUY_INPUT_MINT ||
        capture.inputDecimals !== 9)) ||
    (context.side === 'Sell' &&
      capture.format !== 'conditional-preparation-v1') ||
    terms.projectId !== context.projectId ||
    terms.projectRevision !== context.projectRevision ||
    terms.wallet !== context.wallet ||
    terms.walletRevision !== context.walletRevision ||
    terms.mint !== context.mint ||
    terms.decimals !== context.decimals ||
    level.unitsRaw !== context.unitsRaw ||
    capture.orderId !== order.id ||
    capture.orderRevision !== order.revision ||
    capture.level !== level.level ||
    capture.pair !== terms.pair ||
    capture.direction !== terms.direction ||
    capture.targetUsd !== level.targetUsd ||
    capture.unitsRaw !== level.unitsRaw
  )
    throw new Error(
      'Preparation differs from the selected saved conditional level.',
    );
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(terms)),
  );
  const fingerprint = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (capture.termsSha256 !== fingerprint)
    throw new Error(
      'Preparation differs from the saved conditional terms fingerprint.',
    );
  return capture;
}
