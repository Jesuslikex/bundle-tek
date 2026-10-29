# Isolated Linux validator baseline

At the user's request Ubuntu was installed as a new WSL2 distribution and
started successfully. Build dependencies were installed inside that distribution:
compiler toolchain, Clang/libclang, CMake, Protobuf, Git, curl, Perl and
development libraries. A separate Linux checkout in /root/jito-validator-research
is at upstream Jito-Solana revision 256fbf9b601a98551636a2a394158067014f47b3.
The Windows Bundle and validator checkouts were not modified by this setup.

The official rustup-init was downloaded and checked against its published
SHA-256, then Rust 1.99.1 was installed with the minimal profile in the new
distribution without modifying PATH automatically. The unmodified Linux source
baseline started with `cargo test -p solana-rpc
test_rpc_simulate_bundle_happy_path --lib --locked`, using four build jobs.
At this checkpoint it was still fetching dependencies; no test pass is claimed.

At that checkpoint the same-bank endpoint had not yet been built. Jupiter binary provenance and
full-swap qualification remain unresolved. No qualification check, provider,
hosted state, signing or deployment was changed. No funded trade occurred.

## Follow-up build and verification

The full patched `agave-validator` executable built successfully after
initializing the exact `jito-protos/protos` and `jito-protos/bam-protos`
submodule revisions pinned by the parent checkout. The binary's `--version`
reports JitoLabs 4.5.0-alpha.2 at source 256fbf9b. The unmodified upstream
bundle RPC happy path passed, as did all 7 patched bundle RPC tests. Bundle's
existing 4 read-only qualification, coherent prefee, coherent simulation and
simulation-frame test files passed 164 tests. These are local synthetic tests,
not a live full-swap qualification. See the prototype note for the remaining
trust, request-binding, code-identity, integration and runtime requirements.
No validator was started as a mainnet node, no deployment was performed, and
no funded transaction was signed or sent.
