import { previewHolderDistribution } from './launch-distribution';
import { quoteAsset, quoteCatalog } from './quote-catalog';
import type { LaunchPlanInput, LaunchChain } from './launch-plan';
import type { LaunchWalletAssignments } from './launch-wallets';
import {
  activeLaunchWallets,
  assignmentEntries,
  walletReferenceFolderMatches,
} from './launch-wallets';
import { type WalletWorkspace } from './wallet-workspace';
export function launchFundingRecipients(
  selection: LaunchWalletAssignments | undefined,
  workspace: WalletWorkspace,
  chain: LaunchChain,
  recipientAmount: string,
  includeDeployer: boolean,
  deployerAmount: string,
) {
  if (!selection || selection.chain !== chain)
    throw new Error('Choose launch wallets on the funding network first.');
  const refs = assignmentEntries(selection).filter(
    (ref) => ref.role === 'Recipient' || includeDeployer,
  );
  if (!refs.length || refs.length > 100)
    throw new Error(
      'A funding draft supports 1 to 100 selected addresses, including the optional deployer. Nothing was copied.',
    );
  if (includeDeployer && !selection.deployer)
    throw new Error(
      'Select a launch deployer before including its allocation.',
    );
  const active = activeLaunchWallets(workspace, chain);
  return refs.map((ref) => {
    const wallet = active.find(
      (w) => w.address === ref.address && w.role === ref.role,
    );
    if (
      !wallet ||
      wallet.revision !== ref.revision ||
      !walletReferenceFolderMatches(ref, wallet, workspace)
    )
      throw new Error(
        'Launch wallet selection changed or was archived. Reselect current wallets in Launch Settings before copying.',
      );
    return {
      address: ref.address,
      amount: ref.role === 'Deployer' ? deployerAmount : recipientAmount,
    };
  });
}

// Transfers planning amounts only. Native equivalents are explicit: a token
// sharing the same symbol must never silently become a native funding amount.
export function launchDistributionFundingRecipients(
  plan: LaunchPlanInput,
  selection: LaunchWalletAssignments | undefined,
  workspace: WalletWorkspace,
  chain: LaunchChain,
  currency: string,
  includeDeployer: boolean,
  deployerAmount: string,
  fundingAssetAddress?: string,
) {
  if (plan.chain !== chain || plan.currency !== currency)
    throw new Error(
      'Funding network and currency must match the launch distribution.',
    );
  const native: Record<LaunchChain, string> = {
    Solana: 'SOL',
    Robinhood: 'ETH',
    BNB: 'BNB',
    Arc: 'USDC',
    Ethereum: 'ETH',
    Base: 'ETH',
  };
  const equivalents: Record<LaunchChain, string[]> = {
    Solana: ['So11111111111111111111111111111111111111112'],
    Robinhood: ['0x0bd7d308f8e1639fab988df18a8011f41eacad73'],
    BNB: ['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'],
    Arc: ['0x0000000000000000000000000000000000000000'],
    Ethereum: ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'],
    Base: ['0x4200000000000000000000000000000000000006'],
  };
  const assets = quoteCatalog(plan.chain, plan.launchpad).assets.filter(
    (a) => a.symbol === currency,
  );
  const asset = plan.quoteAddress
    ? quoteAsset(plan.chain, plan.launchpad, plan.quoteAddress)
    : assets.length === 1
      ? assets[0]
      : undefined;
  if (
    fundingAssetAddress !== undefined &&
    (!asset ||
      (chain === 'Solana'
        ? asset.address !== fundingAssetAddress
        : asset.address.toLowerCase() !== fundingAssetAddress.toLowerCase()))
  )
    throw new Error('Funding asset address must match the launch quote token.');
  if (
    fundingAssetAddress === undefined &&
    (currency !== native[chain] ||
      !asset ||
      !equivalents[chain].includes(asset.address))
  )
    throw new Error(
      'Distribution copying requires the captured native quote equivalent. Token funding identity is not yet supported.',
    );
  const preview = previewHolderDistribution(plan);
  if (!preview || preview.unit === '%')
    throw new Error(
      'Configure a quote-amount holder distribution in Launch Settings first. Supply percentages cannot become funding amounts.',
    );
  if (selection?.recipients.length !== preview.items.length)
    throw new Error(
      'Select one Recipient address for every holder slot before copying. Nothing was copied.',
    );
  if (preview.items.some((item) => item.amount === '0'))
    throw new Error(
      'Some holder slots receive zero. Adjust the distribution before copying; no addresses were dropped.',
    );
  const recipients = launchFundingRecipients(
    selection,
    workspace,
    chain,
    '0',
    includeDeployer,
    deployerAmount,
  );
  const offset = includeDeployer ? 1 : 0;
  return recipients.map((recipient, index) =>
    index < offset
      ? recipient
      : { ...recipient, amount: preview.items[index - offset].amount },
  );
}
