import { z } from 'zod';
import { projectIdValid } from './workspace-project';
import { walletAddress } from './wallet-workspace';
const id = z.string().refine(projectIdValid);
export const layerTargetSourceSchema = z
  .object({
    projectId: id,
    projectUpdatedAt: z
      .string()
      .refine(
        (value) =>
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString() === value,
      ),
  })
  .strict();
export type LayerTargetSource = z.infer<typeof layerTargetSourceSchema>;
const item = z
  .object({
    id,
    revision: z.number().int().positive(),
    chain: z.literal('Solana'),
    mint: z.string().refine((value) => {
      try {
        return (
          walletAddress(value, 'Solana') === value &&
          value !== '11111111111111111111111111111111'
        );
      } catch {
        return false;
      }
    }),
    name: z.string().trim().min(1).max(256),
    symbol: z.string().trim().min(1).max(64),
  })
  .strict();
export function parseImportedLayerTargets(
  value: unknown,
  source: LayerTargetSource,
) {
  const result = z
    .object({
      projectId: z.literal(source.projectId),
      projectUpdatedAt: z.literal(source.projectUpdatedAt),
      items: z.array(item).max(100),
      hasMore: z.boolean(),
      readOnly: z.literal(true),
      fundingAllowed: z.literal(false),
      signingAllowed: z.literal(false),
      executionAllowed: z.literal(false),
    })
    .strict()
    .parse(value);
  if (result.hasMore && result.items.length !== 100)
    throw new Error('Incomplete imported target window.');
  if (new Set(result.items.map((row) => row.id)).size !== result.items.length)
    throw Error('Imported target list contains duplicate records.');
  return result;
}
export type ImportedLayerTargets = ReturnType<typeof parseImportedLayerTargets>;
