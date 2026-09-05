export function canUseDevnetTools(chain: string, exploringRobinhood = false) { return chain === 'Solana' && !exploringRobinhood; }
