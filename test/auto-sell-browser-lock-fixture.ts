/** Controlled browser lock API for jsdom UI tests. Real acquisition/release
 * callbacks are exercised; this never unlocks a real vault or sends a trade. */
export function installAutoSellBrowserLocks() {
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      async request(
        name: string,
        _options: unknown,
        callback: (lock: { name: string } | null) => unknown,
      ) {
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          return await callback({ name });
        } finally {
          held.delete(name);
        }
      },
    },
  });
  return () => {
    if (original) Object.defineProperty(navigator, 'locks', original);
    else Reflect.deleteProperty(navigator, 'locks');
  };
}
