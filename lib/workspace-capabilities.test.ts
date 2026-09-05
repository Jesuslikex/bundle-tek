import { expect, it } from 'vitest';
import { canUseDevnetTools } from './workspace-capabilities';
it('permits devnet tools only for the Solana plan, never a Robinhood exploration', () => {
 expect(canUseDevnetTools('Solana', false)).toBe(true);
 for (const chain of ['Base', 'BNB', 'Robinhood']) expect(canUseDevnetTools(chain, false)).toBe(false);
 expect(canUseDevnetTools('Solana', true)).toBe(false);
});
