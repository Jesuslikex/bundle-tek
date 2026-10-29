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

The same-bank endpoint has not yet been built. Jupiter binary provenance and
full-swap qualification remain unresolved. No qualification check, provider,
hosted state, signing or deployment was changed. No funded trade occurred.
