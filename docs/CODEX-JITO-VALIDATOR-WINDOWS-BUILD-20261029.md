# Local Jito validator build investigation

The separate `jito-validator-research` checkout is at upstream revision
256fbf9b601a98551636a2a394158067014f47b3. It is not the Bundle checkout and
is not a deployed validator. The original `cargo test -p solana-rpc
test_rpc_simulate_bundle_happy_path --lib --locked` failed because the Cargo
Git checkout of crossbeam-epoch contained a Windows plain-text symlink instead
of its target source.

An isolated sibling `jito-crossbeam-research` copy uses the same dependency
revision with the three symlink target contents copied into their link paths.
Only the research validator Cargo.toml and its Cargo.lock were changed to use
that local path. This is an altered build environment, not an unchanged locked
build; no shared Cargo cache or Bundle source was edited. The next build passed
the crossbeam error and failed at vendored OpenSSL because Perl was unavailable.

Official Strawberry Perl 5.42.2.1 portable was downloaded into the research
workspace; SHA256 32d83be90cf04b807cfb9477482bc36302cdee6f5b04cf57e81adecbd8f07898
matched the publisher's releases.json. It was extracted locally and added to
the build process PATH only. The subsequent build got further, then clang-sys
reported that it could not find clang.dll or libclang.dll. At this checkpoint,
other compiler jobs were winding down; the upstream test has not passed.

The custom same-bank endpoint has not been implemented or tested. The separate
Jupiter source-to-binary verification and full-swap qualification are also open.
No application policy, provider, hosted database, signing, deployment or funded
action was changed. Do not treat this research toolchain as release evidence.

Follow-up: official LLVM 21.1.8 Windows installer was downloaded to the
research workspace and its SHA-256 matched GitHub's release asset digest
7a5386c26497db1691f320121e5b113364dd0274b98e55f15f4dbc00c0450113.
Windows tar could not extract the executable. An attempted command to download
and administratively extract the official 7-Zip MSI for unpacking was rejected
by automatic approval review with "blocked by policy"; it did not execute and
was not retried or bypassed. LLVM has not been installed or extracted and the
libclang dependency remains unresolved. The earlier Cargo process had reported
the missing libclang error while waiting for other jobs; no test pass is claimed.

Subsequently the official LLVM 21.1.8 Windows tar.xz release was downloaded
directly, avoiding the rejected MSI extraction. Its SHA-256 matched the release
asset digest 749d22f565fcd5718dbed06512572d0e5353b502c03fe1f7f17ee8b8aca21a47.
Windows tar extracted libclang.dll and its matching libclang.lib into the
isolated jito-llvm-research directory; no installer or system PATH change was
used. A DLL load probe found clang_getClangVersion but exited abnormally after
printing success, so it is not a clean test. A validator baseline retry using
a shorter isolated target directory found the DLL but failed before the import
library was extracted; other build jobs remained active at this checkpoint.
The baseline must finish and be retried with both files before claiming that
the libclang build issue is fixed. A previous build also showed an OpenSSL
compiler error; whether the shorter target fixes that remains unverified.

Next baseline run with both LLVM files passed the previous libclang discovery
point but failed because protoc and sh were missing. Official protoc 36.2 was
downloaded to an isolated directory and its release SHA-256
f0c128dc0d8492eceece83bb459a4c0e316764b929ffbf1aa416357fd644edd3 was
verified. The next run used that protoc and the existing bundled Git shell,
with paths set only in the build process. It progressed past those errors but
jemalloc's configure failed: the shell parsed the Visual Studio compiler path
at its spaces (`C:\\Program` not found). Jemalloc itself warns its Windows
MSVC target is untested. Other compiler jobs were still running at checkpoint;
the baseline test has not passed. A compiler-name-only process override has
not yet been tested and might expose further platform incompatibilities.
The research checkout retains the local crossbeam Cargo.toml/lock modifications;
no application or qualification checks were changed.
