/** Window event the app shell listens for to open one imported token's chart. */
export const OPEN_IMPORTED_PROJECT_EVENT = 'bundle:open-imported-project';

type Project = {
  id: string;
  archived: boolean;
  document: { token: { chain: string; address: string } };
};

function matchesProject(value: unknown, mint: string): value is Project {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const project = value as Partial<Project>;
  return (
    typeof project.id === 'string' &&
    project.id.length > 0 &&
    project.id.length <= 128 &&
    typeof project.archived === 'boolean' &&
    project.document?.token?.chain === 'Solana' &&
    project.document?.token?.address === mint
  );
}

async function json(response: Response) {
  const value = (await response.json().catch(() => ({}))) as {
    error?: string;
    projects?: Project[];
    project?: Project;
  };
  if (!response.ok) throw new Error(value.error || 'Chart unavailable.');
  return value;
}

/**
 * Finds the user's imported project for a launched Solana mint, importing it
 * once if needed, then asks the app to open its chart. Read-only toward the
 * chain apart from the existing token identity lookup.
 */
export async function openLaunchChart(mint: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const list = await json(
    await fetch('/api/imported-projects', { signal, cache: 'no-store' }),
  );
  signal?.throwIfAborted();
  if (!Array.isArray(list.projects))
    throw new Error('Imported projects could not be verified.');
  let project =
    list.projects.find((p) => matchesProject(p, mint) && !p.archived) ??
    list.projects.find((p) => matchesProject(p, mint));
  if (!project) {
    const created = await json(
      await fetch('/api/imported-projects', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'import',
          chain: 'Solana',
          address: mint,
        }),
      }),
    );
    signal?.throwIfAborted();
    project = created.project;
    if (!matchesProject(project, mint) || project.archived)
      throw new Error('Imported token differs from this launch.');
  }
  signal?.throwIfAborted();
  window.dispatchEvent(
    new CustomEvent(OPEN_IMPORTED_PROJECT_EVENT, {
      detail: { id: project.id },
    }),
  );
  return project.id;
}
