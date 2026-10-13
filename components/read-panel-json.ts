/** Parse a panel response without exposing HTML pages or parser diagnostics. */
export async function readPanelJson(
  response: Response,
  message: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(message);
  }
}
