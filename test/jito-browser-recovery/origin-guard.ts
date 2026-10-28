/** Fail closed before touching test-origin IndexedDB. */
export function requireFreshSyntheticOrigin(
  hostname: string,
  databases: unknown,
) {
  if (
    !/^jito-[a-f0-9]{32}\.localhost$/.test(hostname) ||
    !Array.isArray(databases) ||
    databases.length !== 0
  )
    throw Error('Synthetic origin is not demonstrably fresh.');
}
export function requireOwnedSyntheticJournal(
  hostname: string,
  databases: unknown,
) {
  if (
    !/^jito-[a-f0-9]{32}\.localhost$/.test(hostname) ||
    !Array.isArray(databases) ||
    databases.length !== 1 ||
    databases[0]?.name !== 'pulseforge.jito-recovery-journal.v1' ||
    databases[0]?.version !== 1
  )
    throw Error('Synthetic journal ownership is not demonstrable.');
}
