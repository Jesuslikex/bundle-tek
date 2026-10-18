import { z } from 'zod';
import { projectIdValid } from './workspace-project';
import { walletAddress } from './wallet-workspace';
const id = z.string().refine(projectIdValid);
export const layerTargetStamp = z
  .string()
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
export const layerTargetSourceSchema = z
  .object({ projectId: id, projectUpdatedAt: layerTargetStamp })
  .strict();
export type LayerTargetSource = z.infer<typeof layerTargetSourceSchema>;
export const layerTargetCursorSchema = z
  .object({
    version: z.literal(1),
    projectId: id,
    projectUpdatedAt: layerTargetStamp,
    search: z.string().max(80),
    id,
    revision: z.number().int().positive(),
    updatedAt: layerTargetStamp,
  })
  .strict();
export type LayerTargetCursor = z.infer<typeof layerTargetCursorSchema>;
export const layerTargetQuerySchema = layerTargetSourceSchema
  .extend({
    search: z.string().trim().max(80).default(''),
    cursor: layerTargetCursorSchema.optional(),
  })
  .strict();
export type LayerTargetQuery = LayerTargetSource & {
  search?: string;
  cursor?: LayerTargetCursor;
};
export function layerTargetCursorMatches(
  cursor: LayerTargetCursor,
  query: LayerTargetQuery,
) {
  return (
    cursor.projectId === query.projectId &&
    cursor.projectUpdatedAt === query.projectUpdatedAt &&
    cursor.search === (query.search ?? '')
  );
}
const cursorKey = (cursor: LayerTargetCursor | null | undefined) =>
  cursor
    ? JSON.stringify([
        cursor.version,
        cursor.projectId,
        cursor.projectUpdatedAt,
        cursor.search,
        cursor.id,
        cursor.revision,
        cursor.updatedAt,
      ])
    : null;
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
  source: LayerTargetQuery,
) {
  const expectedSearch = source.search ?? '';
  const result = z
    .object({
      projectId: z.literal(source.projectId),
      projectUpdatedAt: z.literal(source.projectUpdatedAt),
      search: z.string().max(80).default(''),
      pageCursor: layerTargetCursorSchema.nullable().default(null),
      nextCursor: layerTargetCursorSchema.nullable().default(null),
      items: z.array(item).max(100),
      hasMore: z.boolean(),
      readOnly: z.literal(true),
      fundingAllowed: z.literal(false),
      signingAllowed: z.literal(false),
      executionAllowed: z.literal(false),
    })
    .strict()
    .parse(value);
  if (
    result.search !== expectedSearch ||
    cursorKey(result.pageCursor) !== cursorKey(source.cursor)
  )
    throw Error('Imported target page context differs.');
  if (
    result.hasMore !== Boolean(result.nextCursor) ||
    (result.hasMore && result.items.length !== 100)
  )
    throw Error('Incomplete imported target window.');
  if (result.nextCursor) {
    const last = result.items.at(-1);
    if (
      !last ||
      result.nextCursor.id !== last.id ||
      result.nextCursor.revision !== last.revision ||
      !layerTargetCursorMatches(result.nextCursor, source) ||
      cursorKey(result.nextCursor) === cursorKey(source.cursor)
    )
      throw Error('Imported target continuation differs.');
  }
  if (result.pageCursor && !layerTargetCursorMatches(result.pageCursor, source))
    throw Error('Imported target page source differs.');
  if (
    new Set(result.items.map((row) => row.id)).size !== result.items.length ||
    result.items.some((row) => row.id === source.cursor?.id)
  )
    throw Error('Imported target list repeats a record.');
  return result;
}
export type ImportedLayerTargets = ReturnType<typeof parseImportedLayerTargets>;
