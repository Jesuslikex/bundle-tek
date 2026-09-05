import {
  decodeFunctionResult,
  parseAbi,
  zeroAddress,
  keccak256,
  type PublicClient,
} from 'viem';
import { buildLaunch, FACTORY, ROUTER, routerAbi, CHAIN_ID } from './chain';
import { PonsError, type Intent } from './intent';
export const factoryAbi = parseAbi([
  'struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }',
  'function canLaunch(address) view returns (bool)',
  'function launchConfigCount() view returns (uint256)',
  'function getLaunchConfig(uint256 id) view returns (LaunchConfig)',
  'function launchFee() view returns (uint256)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function previewLaunchEconomics(uint256 launchConfigId,address pairToken) view returns (bytes32)',
]);
export async function simulateIntent(
  i: Intent,
  client: PublicClient,
  now = Date.now(),
) {
  if ((await client.getChainId()) !== CHAIN_ID)
    throw new PonsError(422, 'WRONG_RPC_CHAIN');
  const block = await client.getBlock({ blockTag: 'latest' });
  if (block.number === null || !block.hash)
    throw new PonsError(502, 'INVALID_BLOCK');
  if (typeof block.timestamp !== 'bigint' || block.timestamp < 0n)
    throw new PonsError(502, 'INVALID_BLOCK_TIMESTAMP');
  const age = BigInt(Math.floor(now / 1000)) - block.timestamp;
  if (age > 60n || age < -15n) throw new PonsError(502, 'RPC_BLOCK_STALE');
  const blockNumber = block.number;
  const [
    factoryCode,
    routerCode,
    allowed,
    routerAllowed,
    routerFactory,
    count,
    config,
    fee,
    cap,
    pin,
    balance,
    nonce,
    gasPrice,
  ] = await Promise.all([
    client.getCode({ address: FACTORY, blockNumber }),
    client.getCode({ address: ROUTER, blockNumber }),
    client.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'canLaunch',
      args: [i.wallet],
      blockNumber,
    }),
    client.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'canLaunch',
      args: [ROUTER],
      blockNumber,
    }),
    client.readContract({
      address: ROUTER,
      abi: parseAbi(['function factory() view returns(address)']),
      functionName: 'factory',
      blockNumber,
    }),
    client.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'launchConfigCount',
      blockNumber,
    }),
    client.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'getLaunchConfig',
      args: [BigInt(i.launchConfigId)],
      blockNumber,
    }),
    client.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'launchFee',
      blockNumber,
    }),
    client.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'maxCreatorTaxBps',
      blockNumber,
    }),
    client.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'previewLaunchEconomics',
      args: [BigInt(i.launchConfigId), zeroAddress],
      blockNumber,
    }),
    client.getBalance({ address: i.wallet, blockNumber }),
    client.getTransactionCount({ address: i.wallet, blockTag: 'pending' }),
    client.getGasPrice(),
  ]);
  if (
    !factoryCode ||
    factoryCode === '0x' ||
    !routerCode ||
    routerCode === '0x'
  )
    throw new PonsError(422, 'MISSING_CONTRACT_CODE');
  if (routerFactory.toLowerCase() !== FACTORY.toLowerCase())
    throw new PonsError(422, 'ROUTER_FACTORY_MISMATCH');
  if (!allowed || !routerAllowed)
    throw new PonsError(422, 'LAUNCH_GATE_CLOSED');
  if (BigInt(i.launchConfigId) >= count || !config.enabled)
    throw new PonsError(422, 'CONFIG_DISABLED');
  if (BigInt(i.creatorTaxBps) > cap)
    throw new PonsError(422, 'CREATOR_TAX_OVER_CAP');
  const tx = buildLaunch(i, pin, fee);
  if (tx.value > BigInt(i.maxTotalValueWei))
    throw new PonsError(422, 'TOTAL_VALUE_CEILING_EXCEEDED');
  if (balance < tx.value) throw new PonsError(422, 'INSUFFICIENT_ETH');
  const request = {
    account: i.wallet,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gasPrice,
    nonce,
    blockNumber,
  };
  const gasEstimate = await client.estimateGas(request);
  const gas = (gasEstimate * 120n + 99n) / 100n;
  if (gas * gasPrice > BigInt(i.maxGasCostWei))
    throw new PonsError(422, 'GAS_COST_CEILING_EXCEEDED');
  if (balance < tx.value + gas * gasPrice)
    throw new PonsError(422, 'INSUFFICIENT_ETH_FOR_GAS');
  const called = await client.call({ ...request, gas });
  if (!called.data) throw new PonsError(422, 'EMPTY_SIMULATION_RESULT');
  const [token, curve, tokensOut] = decodeFunctionResult({
    abi: routerAbi,
    functionName: 'launchAndBuy',
    data: called.data,
  });
  const canonical = await client.getBlock({ blockNumber });
  if (canonical.hash !== block.hash)
    throw new PonsError(409, 'SIMULATION_BLOCK_REORG');
  return {
    ok: true as const,
    simulatedAt: now,
    expiresAt: now + 120000,
    nonceStatus: 'not reserved' as const,
    blockNumber: blockNumber.toString(),
    blockTimestamp: block.timestamp.toString(),
    blockHash: block.hash,
    maxTotalValueWei: i.maxTotalValueWei,
    maxGasCostWei: i.maxGasCostWei,
    expectedEconomics: pin,
    launchFeeWei: fee.toString(),
    factoryCodeHash: keccak256(factoryCode),
    routerCodeHash: keccak256(routerCode),
    gasEstimate: gasEstimate.toString(),
    gasPriceWei: gasPrice.toString(),
    balanceWei: balance.toString(),
    output: { token, curve, tokensOut: tokensOut.toString() },
    unsignedTransaction: {
      chainId: CHAIN_ID,
      from: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value.toString(),
      gas: gas.toString(),
      gasPrice: gasPrice.toString(),
      nonce,
    },
    warnings: [
      'Simulation is not execution or authorization.',
      'Nonce is a snapshot, not reserved. Refresh simulation and wallet fees before signing.',
      'Atomicity covers one launch and one recipient only; exemptions are not wallet allocations.',
      'minTokensOut is a rate bound; a clamped partial fill may return fewer tokens.',
    ],
  };
}
