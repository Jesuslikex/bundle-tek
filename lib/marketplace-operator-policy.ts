import { env } from './server-env';
/** Configuration is an explicit JSON array of verified session user IDs. No wildcard, email, request claim or fallback owner. */
export function configuredMarketplaceOperators(
  configuration: Record<string, string | undefined> = env,
): string[] {
  const raw = configuration.MARKETPLACE_OPERATOR_USER_IDS;
  if (!raw || raw.length > 4096) return [];
  try {
    const ids: unknown = JSON.parse(raw);
    return Array.isArray(ids) &&
      ids.length >= 1 &&
      ids.length <= 20 &&
      ids.every(
        (value) =>
          typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value),
      ) &&
      new Set(ids).size === ids.length
      ? (ids as string[])
      : [];
  } catch {
    return [];
  }
}
export function isMarketplaceOperator(
  userId: string,
  configuration: Record<string, string | undefined> = env,
): boolean {
  return (
    typeof userId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(userId) &&
    configuredMarketplaceOperators(configuration).includes(userId)
  );
}
