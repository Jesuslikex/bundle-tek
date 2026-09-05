import { encodeFunctionData, parseAbi, zeroAddress, type Hex } from 'viem';
import { type Intent } from './intent';
export const CHAIN_ID = 4663;
export const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' as const;
export const ROUTER = '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948' as const;
const structs = [
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
] as const;
export const routerAbi = parseAbi([
  ...structs,
  'function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)',
]);
export function buildLaunch(
  i: Intent,
  expectedEconomics: Hex,
  launchFee: bigint,
) {
  const params = {
    name: i.name,
    symbol: i.symbol,
    logo: i.logo,
    description: i.description,
    socials: i.socials,
    creatorFeeRecipient: i.creatorFeeRecipient,
    creatorTaxBps: i.creatorTaxBps,
    buybackEnabled: i.buybackEnabled,
    expectedEconomics,
    salt: i.salt,
  };
  return {
    from: i.wallet,
    to: ROUTER,
    value: launchFee + BigInt(i.quoteInWei),
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'launchAndBuy',
      args: [
        params,
        BigInt(i.launchConfigId),
        zeroAddress,
        BigInt(i.quoteInWei),
        BigInt(i.minTokensOut),
        i.recipient,
        i.snipeTaxExemptions,
      ],
    }),
  };
}
