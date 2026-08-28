export type PulseStrategyInput = {
  strategy: 'Balanced' | 'Liquidity' | 'Discovery';
  agents: number;
  budget: number;
  cadence: number;
  orderSize: number;
  spread: number;
  inventory: number;
};

export function validatePulseStrategy(value: unknown): PulseStrategyInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid strategy payload');
  const body = value as Record<string, unknown>;
  const strategy = body.strategy;
  if (!['Balanced', 'Liquidity', 'Discovery'].includes(String(strategy))) throw new Error('Invalid strategy');
  const input = {
    strategy: strategy as PulseStrategyInput['strategy'],
    agents: Number(body.agents), budget: Number(body.budget), cadence: Number(body.cadence),
    orderSize: Number(body.orderSize), spread: Number(body.spread), inventory: Number(body.inventory),
  };
  if (!Number.isInteger(input.agents) || input.agents < 1 || input.agents > 20) throw new Error('Agents must be 1-20');
  if (input.budget < 0.5 || input.budget > 100) throw new Error('Budget must be 0.5-100 SOL');
  if (!Number.isInteger(input.cadence) || input.cadence < 5 || input.cadence > 180) throw new Error('Cadence must be 5-180 seconds');
  if (input.orderSize < 0.1 || input.orderSize > 3) throw new Error('Order size must be 0.1-3 SOL');
  if (!Number.isInteger(input.spread) || input.spread < 20 || input.spread > 300) throw new Error('Spread must be 20-300 bps');
  if (!Number.isInteger(input.inventory) || input.inventory < 20 || input.inventory > 80) throw new Error('Inventory must be 20-80%');
  return input;
}

export function projectPulseCycle(input: PulseStrategyInput) {
  const orders = Math.max(1, Math.round((3600 / input.cadence) * input.agents * (input.strategy === 'Liquidity' ? 1.12 : input.strategy === 'Discovery' ? 0.72 : 0.9)));
  const turnover = orders * input.orderSize * 0.58;
  const risk = Math.max(12, Math.min(94, Math.round((180 - input.cadence) / 3 + input.orderSize * 9 + (120 - input.spread) / 5)));
  return { orders, turnover: Number(turnover.toFixed(2)), risk };
}
