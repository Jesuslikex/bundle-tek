import { z } from 'zod';
import bs58 from 'bs58';
import { projectIdValid } from './workspace-project';

const stamp = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});
const item = z
  .object({
    id: z.uuid(),
    projectUpdatedAt: stamp,
    createdAt: stamp,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    target: z
      .object({
        kind: z.enum(['new', 'imported']),
        mint: z.string().refine((value) => {
          if (value.length < 32 || value.length > 44) return false;
          try {
            return (
              bs58.decode(value).length === 32 &&
              bs58.encode(bs58.decode(value)) === value
            );
          } catch {
            return false;
          }
        }),
      })
      .strict(),
  })
  .strict();
export type LaunchLayerHistoryItem = z.infer<typeof item>;
export function parseLaunchLayerHistory(value: unknown, projectId: string) {
  if (!projectIdValid(projectId))
    throw new Error('Choose a saved launch project.');
  const result = z
    .object({
      projectId: z.literal(projectId),
      items: z.array(item).max(100),
      complete: z.literal(true),
      planningOnly: z.literal(true),
      fundingAllowed: z.literal(false),
      signingAllowed: z.literal(false),
      executionAllowed: z.literal(false),
    })
    .strict()
    .safeParse(value);
  if (!result.success)
    throw new Error(
      'Saved planning history could not be confirmed. Reload before choosing a snapshot.',
    );
  const entries = result.data.items;
  if (
    new Set(entries.map((entry) => entry.id)).size !== entries.length ||
    entries.some(
      (entry, index) =>
        index > 0 &&
        (entries[index - 1].createdAt < entry.createdAt ||
          (entries[index - 1].createdAt === entry.createdAt &&
            entries[index - 1].id < entry.id)),
    )
  )
    throw new Error(
      'Saved planning history has an inconsistent order. Reload before choosing a snapshot.',
    );
  return result.data;
}
