export const CHAINS = ['Solana', 'Base', 'BNB'] as const;
export type LaunchChain = (typeof CHAINS)[number];

export const LAUNCH_MODES = ['Block-0', 'Organic', 'Manual'] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

export const LAUNCH_PRESETS = ['Quick', 'Clean', 'Full', 'Custom'] as const;
export type LaunchPreset = (typeof LAUNCH_PRESETS)[number];

export const VENUES_BY_CHAIN: Record<LaunchChain, readonly string[]> = {
  Solana: ['PumpFun', 'LetsBonk', 'Bags', 'Meteora DBC'],
  Base: ['Clanker', 'Bankr'],
  BNB: ['FourMeme', 'Flap'],
};

export const CURRENCIES_BY_CHAIN: Record<LaunchChain, readonly string[]> = {
  Solana: ['SOL', 'USDC'],
  Base: ['Base'],
  BNB: ['BNB'],
};

export type SimulationSafetyPolicy = {
  maxIllustrativeTurnover: number;
  maxScenarioExposure: number;
  minimumInventoryReservePercent: number;
  stopLossPercent: number;
  maximumDurationMinutes: number;
  executionEnabled: false;
  artificialVolumeProhibited: true;
  holderFarmingProhibited: true;
};

export type LaunchPlanInput = {
  chain: LaunchChain;
  launchpad: string;
  currency: string;
  tokenName: string;
  ticker: string;
  description: string;
  mode: LaunchMode;
  preset: LaunchPreset;
  developerBuy: number;
  holdersBuy: number;
  holderCount: number;
  routingEmphasis: number;
  useHusher: boolean;
  scheduled: boolean;
  simulationSafety: SimulationSafetyPolicy;
};

export type SavedLaunchPlan = LaunchPlanInput & { updatedAt: string };

export const DEFAULT_LAUNCH_PLAN: LaunchPlanInput = {
  chain: 'Solana',
  launchpad: 'PumpFun',
  currency: 'SOL',
  tokenName: 'Untitled Plan',
  ticker: 'TOKEN',
  description: '',
  mode: 'Block-0',
  preset: 'Clean',
  developerBuy: 5,
  holdersBuy: 20,
  holderCount: 10,
  routingEmphasis: 46,
  useHusher: false,
  scheduled: false,
  simulationSafety: {
    maxIllustrativeTurnover: 250,
    maxScenarioExposure: 50,
    minimumInventoryReservePercent: 20,
    stopLossPercent: 8,
    maximumDurationMinutes: 60,
    executionEnabled: false,
    artificialVolumeProhibited: true,
    holderFarmingProhibited: true,
  },
};

function requireFiniteNumber(body: Record<string, unknown>, key: keyof LaunchPlanInput) {
  const value = Number(body[key]);
  if (!Number.isFinite(value)) throw new Error(`${String(key)} must be a finite number`);
  return value;
}

function requireString(body: Record<string, unknown>, key: keyof LaunchPlanInput) {
  const value = body[key];
  if (typeof value !== 'string') throw new Error(`${String(key)} must be a string`);
  return value;
}

function validateSimulationSafety(value: unknown): SimulationSafetyPolicy {
  if (!value || typeof value !== "object") throw new Error("Simulation safety policy is required");
  const body = value as Record<string, unknown>;
  const numericKeys = [
    "maxIllustrativeTurnover",
    "maxScenarioExposure",
    "minimumInventoryReservePercent",
    "stopLossPercent",
    "maximumDurationMinutes",
  ] as const;
  const numbers = Object.fromEntries(numericKeys.map((key) => [key, Number(body[key])])) as Record<(typeof numericKeys)[number], number>;
  if (!numericKeys.every((key) => Number.isFinite(numbers[key]))) throw new Error("Simulation safety limits must be finite numbers");
  if (numbers.maxIllustrativeTurnover <= 0 || numbers.maxIllustrativeTurnover > 1_000_000) throw new Error("Illustrative turnover must be greater than 0 and at most 1,000,000");
  if (numbers.maxScenarioExposure <= 0 || numbers.maxScenarioExposure > numbers.maxIllustrativeTurnover) throw new Error("Scenario exposure must be greater than 0 and no more than illustrative turnover");
  if (numbers.minimumInventoryReservePercent < 0 || numbers.minimumInventoryReservePercent > 100) throw new Error("Inventory reserve must be 0-100%");
  if (numbers.stopLossPercent <= 0 || numbers.stopLossPercent > 100) throw new Error("Stop loss must be greater than 0 and at most 100%");
  if (!Number.isInteger(numbers.maximumDurationMinutes) || numbers.maximumDurationMinutes < 1 || numbers.maximumDurationMinutes > 1_440) throw new Error("Maximum duration must be 1-1440 minutes");
  if (body.executionEnabled !== false) throw new Error("Execution must remain disabled");
  if (body.artificialVolumeProhibited !== true) throw new Error("Artificial volume must remain prohibited");
  if (body.holderFarmingProhibited !== true) throw new Error("Holder farming must remain prohibited");
  return {
    ...numbers,
    executionEnabled: false,
    artificialVolumeProhibited: true,
    holderFarmingProhibited: true,
  };
}

export function validateLaunchPlan(value: unknown): LaunchPlanInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid launch plan payload');
  const body = value as Record<string, unknown>;
  const chain = requireString(body, 'chain') as LaunchChain;
  if (!CHAINS.includes(chain)) throw new Error('Unsupported chain profile');
  const launchpad = requireString(body, 'launchpad');
  if (!VENUES_BY_CHAIN[chain].includes(launchpad)) throw new Error('Launchpad does not match chain profile');
  const currency = requireString(body, 'currency');
  if (!CURRENCIES_BY_CHAIN[chain].includes(currency)) throw new Error('Currency does not match chain profile');
  const tokenName = requireString(body, 'tokenName').trim();
  if (tokenName.length < 2 || tokenName.length > 32) throw new Error('Token name must be 2-32 characters');
  const ticker = requireString(body, 'ticker').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,13}$/.test(ticker)) throw new Error('Ticker must be 1-13 letters or numbers');
  const description = requireString(body, 'description').trim();
  if (description.length > 280) throw new Error('Description must be at most 280 characters');
  const mode = requireString(body, 'mode') as LaunchMode;
  if (!LAUNCH_MODES.includes(mode)) throw new Error('Unsupported execution mode');
  const preset = requireString(body, 'preset') as LaunchPreset;
  if (!LAUNCH_PRESETS.includes(preset)) throw new Error('Unsupported launch preset');
  const developerBuy = requireFiniteNumber(body, 'developerBuy');
  const holdersBuy = requireFiniteNumber(body, 'holdersBuy');
  const holderCount = requireFiniteNumber(body, 'holderCount');
  const routingEmphasis = requireFiniteNumber(body, 'routingEmphasis');
  if (developerBuy < 0 || developerBuy > 100) throw new Error('Developer buy must be 0-100%');
  if (holdersBuy < 0 || holdersBuy > 100) throw new Error('Holders buy must be 0-100%');
  if (developerBuy + holdersBuy > 100) throw new Error('Combined allocation cannot exceed 100%');
  if (!Number.isInteger(holderCount) || holderCount < 1 || holderCount > 200) throw new Error('Holder count must be 1-200');
  if (!Number.isInteger(routingEmphasis) || routingEmphasis < 0 || routingEmphasis > 100) throw new Error('Routing emphasis must be 0-100');
  if (typeof body.useHusher !== 'boolean') throw new Error('useHusher must be boolean');
  if (typeof body.scheduled !== 'boolean') throw new Error('scheduled must be boolean');
  const simulationSafety = validateSimulationSafety(body.simulationSafety);
  return {
    chain,
    launchpad,
    currency,
    tokenName,
    ticker,
    description,
    mode,
    preset,
    developerBuy,
    holdersBuy,
    holderCount,
    routingEmphasis,
    useHusher: body.useHusher,
    scheduled: body.scheduled,
    simulationSafety,
  };
}

export function deriveIllustrativeLaunchEstimate(plan: LaunchPlanInput) {
  const allocation = plan.developerBuy + plan.holdersBuy;
  const venueFactor = plan.chain === 'Solana' ? 1 : plan.chain === 'Base' ? 1.18 : 1.12;
  const modeFactor = plan.mode === 'Block-0' ? 1.28 : plan.mode === 'Organic' ? 1.08 : 0.74;
  const layerFactor = plan.mode === 'Block-0' ? 1 + plan.routingEmphasis / 500 : 1;
  const supplyCost = allocation * 0.092 * venueFactor * modeFactor;
  const walletReserve = plan.holderCount * 0.0125 * venueFactor * layerFactor;
  const scenarioTotal = supplyCost + walletReserve;
  return {
    allocation,
    supplyCost: supplyCost.toFixed(2),
    walletReserve: walletReserve.toFixed(2),
    scenarioTotal: scenarioTotal.toFixed(2),
    maximumExposure: (scenarioTotal * 0.6).toFixed(2),
  };
}
