import {
  readBoundedPanelJson,
  PANEL_JSON_RESPONSE_BYTES,
} from './read-bounded-panel-json';
import {
  projectIdValid,
  validateProjectDocument,
  type WorkspaceProject,
} from './workspace-project';

export class OwnedProjectReadError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'Sign in to open this saved project.'
        : status === 404
          ? 'Saved project not found.'
          : status === 400
            ? 'Invalid saved project request.'
            : 'Saved project is unavailable. Refresh and try again.',
    );
    this.name = 'OwnedProjectReadError';
  }
}

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new OwnedProjectReadError(502);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    keys.some((key) => !ownKeys.includes(key))
  )
    throw new OwnedProjectReadError(502);
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new OwnedProjectReadError(502);
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/** A current saved document, never proof of launch execution or permission to sign. */
export function validateOwnedProjectResponse(
  value: unknown,
  expectedId: string,
): WorkspaceProject {
  try {
    if (!projectIdValid(expectedId)) throw new OwnedProjectReadError(400);
    const envelope = exact(value, ['project']);
    const project = exact(envelope.project, [
      'id',
      'archived',
      'updatedAt',
      'plan',
      'identity',
      'options',
    ]);
    if (
      !projectIdValid(project.id) ||
      project.id !== expectedId ||
      typeof project.archived !== 'boolean' ||
      typeof project.updatedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        project.updatedAt,
      ) ||
      new Date(project.updatedAt).toISOString() !== project.updatedAt
    )
      throw new OwnedProjectReadError(502);
    // Keep the same canonical document parser used by the project library.
    const document = validateProjectDocument(project);
    const result = {
      ...document,
      id: project.id,
      archived: project.archived,
      updatedAt: project.updatedAt,
    };
    if (
      new TextEncoder().encode(JSON.stringify({ project })).length >
        PANEL_JSON_RESPONSE_BYTES ||
      new TextEncoder().encode(JSON.stringify({ project: result })).length >
        PANEL_JSON_RESPONSE_BYTES
    )
      throw new OwnedProjectReadError(502);
    return result;
  } catch (error) {
    if (error instanceof OwnedProjectReadError) throw error;
    throw new OwnedProjectReadError(502);
  }
}

export async function readOwnedProjectResponse(
  response: Response,
  expectedId: string,
  signal: AbortSignal,
): Promise<WorkspaceProject> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new OwnedProjectReadError(response.status);
  }
  try {
    const value = await readBoundedPanelJson(response, signal);
    signal.throwIfAborted();
    return validateOwnedProjectResponse(value, expectedId);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof OwnedProjectReadError) throw error;
    throw new OwnedProjectReadError(502);
  }
}
