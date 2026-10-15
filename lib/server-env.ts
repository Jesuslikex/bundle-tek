/** Shared validators can import provider modules without evaluating Node globals. */
export const env =
  typeof window === 'undefined' && typeof process !== 'undefined'
    ? process.env
    : new Proxy<Record<string, string | undefined>>(
        {},
        {
          get() {
            throw new Error(
              'Server provider configuration is unavailable in the browser.',
            );
          },
        },
      );
