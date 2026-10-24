/**
 * Restores `localStorage`/`sessionStorage` for jsdom suites on Node 26.
 *
 * Node 26 defines `localStorage` as an own accessor on `globalThis` that returns
 * `undefined` unless the process runs with `--localstorage-file`, and its own
 * `sessionStorage`. Vitest's jsdom environment only copies a global when the key
 * is not already present (`getWindowKeys` drops keys already `in global`), so
 * Node's versions win: `localStorage` is `undefined`, so any jsdom suite touching
 * browser storage throws before it renders, and `sessionStorage` is Node's class,
 * so `vi.spyOn(Storage.prototype, …)` silently misses it.
 *
 * The fix installs jsdom's *own* storage rather than an imitation, so suites keep
 * real `Storage` semantics and `Storage.prototype` spies keep intercepting. Vitest
 * rewrites `document.defaultView` on the document instance to point at the global;
 * the original getter on `Document.prototype` still reaches the real window, whose
 * storage belongs to the same `Storage` class exposed as the `Storage` global.
 */

type StorageKind = 'localStorage' | 'sessionStorage';

function jsdomStorage(kind: StorageKind): Storage | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'defaultView',
    );
    const owner = descriptor?.get?.call(document) as
      | (Window & typeof globalThis)
      | undefined;
    const storage = owner?.[kind];
    // Only accept it when it really is the class that a `Storage.prototype` spy
    // would intercept; otherwise the suite would silently observe a spy miss.
    if (storage && owner?.Storage?.prototype === globalThis.Storage?.prototype)
      return storage;
  } catch {
    // Fall through to the plain in-memory implementation below.
  }
  return undefined;
}

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      const value = entries.get(String(key));
      return value === undefined ? null : value;
    },
    key(index: number) {
      return [...entries.keys()][index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(String(key));
    },
    setItem(key: string, value: string) {
      entries.set(String(key), String(value));
    },
  };
}

function install(kind: StorageKind, storage: Storage) {
  // Writable so `vi.stubGlobal(kind, …)` still works, configurable so unstubbing
  // can put things back.
  for (const target of new Set<object>([globalThis, window])) {
    Object.defineProperty(target, kind, {
      configurable: true,
      writable: true,
      value: storage,
    });
  }
}

if (typeof window !== 'undefined') {
  const local = jsdomStorage('localStorage');
  if (local) install('localStorage', local);
  // Only reach for the fallback when the existing value is unusable. Reading it
  // is what emits Node's experimental warning, and another DOM environment's
  // working storage must never be replaced by this one.
  else if (typeof globalThis.localStorage === 'undefined')
    install('localStorage', memoryStorage());
  const session = jsdomStorage('sessionStorage');
  if (session) install('sessionStorage', session);
}
