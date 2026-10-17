/** Keep empty/HTML service failures out of workspace-facing error messages. */
export async function readWorkspaceResponse(
  response: Response,
  unavailable: string,
  signIn: string,
): Promise<Record<string, unknown>> {
  if (!response.ok)
    throw new Error(response.status === 401 ? signIn : unavailable);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error(unavailable);
  return body as Record<string, unknown>;
}
