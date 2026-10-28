/** Internal IndexedDB adapter. No authentication, signing or network access. */
const DB = 'pulseforge.jito-recovery-journal.v1';
const STORE = 'packets';
const LIMIT = 100;

export type JournalIdentity = Readonly<{
  ownerScope: string;
  projectId: string;
  sessionId: string;
  bundleId: string;
  digest: string;
  packet: number;
  wallet: string;
}>;
export type JournalEntry = Readonly<{
  version: 1;
  key: string;
  identity: JournalIdentity;
  nonce: string;
  salt: string;
  checkIv: string;
  check: string;
  state: 'unknown' | 'retained';
  iv: string | null;
  ciphertext: string | null;
}>;

function unavailable(): never {
  throw Error('Recovery journal storage is unavailable or invalid.');
}

async function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return unavailable();
  return new Promise((resolve, reject) => {
    let finished = false;
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB, 1);
    } catch {
      reject(Error('Recovery journal storage is unavailable or invalid.'));
      return;
    }
    request.onupgradeneeded = () => {
      try {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE, { keyPath: 'key' });
      } catch {
        request.transaction?.abort();
      }
    };
    request.onblocked = () => {
      if (!finished) {
        finished = true;
        reject(Error('Recovery journal storage is unavailable or invalid.'));
      }
    };
    request.onerror = () => {
      if (!finished) {
        finished = true;
        reject(Error('Recovery journal storage is unavailable or invalid.'));
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (finished) {
        db.close();
        return;
      }
      finished = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

/** Resolve only after the transaction commits. A failed/ambiguous write is
 * never treated as evidence that an earlier marker disappeared. */
async function run<T>(
  mode: IDBTransactionMode,
  setup: (store: IDBObjectStore, abort: () => void) => () => T,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      let result: (() => T) | undefined;
      try {
        tx = db.transaction(STORE, mode, { durability: 'strict' });
        const store = tx.objectStore(STORE);
        if (store.keyPath !== 'key' || store.autoIncrement) throw Error();
        result = setup(store, () => tx.abort());
      } catch {
        try {
          tx!.abort();
        } catch {
          /* No transaction or already aborted. */
        }
        reject(Error('Recovery journal storage is unavailable or invalid.'));
        return;
      }
      tx.oncomplete = () => {
        try {
          resolve(result!());
        } catch {
          reject(Error('Recovery journal storage is unavailable or invalid.'));
        }
      };
      tx.onabort = () =>
        reject(Error('Recovery journal storage is unavailable or invalid.'));
      // Request errors abort the transaction. Do not preventDefault or report
      // success from an individual request before the transaction commits.
      tx.onerror = () => {};
    });
  } finally {
    db.close();
  }
}

export async function readJournalEntry(key: string): Promise<unknown> {
  return run('readonly', (store) => {
    const request = store.get(key);
    return () => request.result;
  });
}

export async function listJournalEntries(): Promise<unknown[]> {
  return run('readonly', (store) => {
    const request = store.getAll(undefined, LIMIT + 1);
    return () => {
      if (!Array.isArray(request.result) || request.result.length > LIMIT)
        return unavailable();
      return request.result;
    };
  });
}

export async function insertJournalUnknown(entry: JournalEntry): Promise<void> {
  return run('readwrite', (store, abort) => {
    const count = store.count();
    count.onsuccess = () => {
      try {
        if (count.result >= LIMIT) abort();
        else store.add(entry);
      } catch {
        abort();
      }
    };
    return () => undefined;
  });
}

/** Exact serialized compare-and-set, without awaiting WebCrypto inside the
 * IndexedDB transaction. Only a matching unknown marker can be replaced. */
export async function retainJournalEntry(
  expected: JournalEntry,
  retained: JournalEntry,
): Promise<void> {
  return run('readwrite', (store, abort) => {
    const get = store.get(expected.key);
    get.onsuccess = () => {
      try {
        if (JSON.stringify(get.result) !== JSON.stringify(expected)) abort();
        else store.put(retained);
      } catch {
        abort();
      }
    };
    return () => undefined;
  });
}

/** Delete only the exact retained envelope after external reconciliation. */
export async function deleteRetainedJournalEntry(
  expected: JournalEntry,
): Promise<void> {
  if (expected.state !== 'retained') return unavailable();
  return run('readwrite', (store, abort) => {
    const get = store.get(expected.key);
    get.onsuccess = () => {
      try {
        if (JSON.stringify(get.result) !== JSON.stringify(expected)) abort();
        else store.delete(expected.key);
      } catch {
        abort();
      }
    };
    return () => undefined;
  });
}
