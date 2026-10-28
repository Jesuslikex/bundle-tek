# Synthetic Jito browser recovery harness

Run `node scripts/jito-synthetic-browser-recovery.mjs` from the repository
root, open the printed loopback URL in an existing Chrome tab and choose Run.
Enter `quit` in the runner to close its server and remove only its verified
temporary build directory. The fixture contains synthetic public test data;
the harness does not request a real wallet, provider or transaction submission.

The runner creates a random 128-bit `.localhost` hostname and restricts the
server to its exact loopback host and port. Before writing, the page requires
an IndexedDB inventory showing no existing databases. It refuses if that
cannot be established. The controlled deletion step checks that only the
test journal database exists; never override these guards to force a run.

The earlier synthetic browser checks exercised real IndexedDB across reload
and Web Locks between a page and a same-origin iframe using a synthetic lock
name. They did not exercise two browser tabs, an actual vault-password change,
the integrated app, a real extension, or a provider. The hardened random-host
run refused at its freshness guard; a full successful browser run of the
hardened harness has not been established.
