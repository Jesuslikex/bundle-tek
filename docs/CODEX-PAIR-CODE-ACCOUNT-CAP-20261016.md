# Stock code identity account cap

## Change

`collectPumpProgramIdentities` accepts an optional server-only maximumAccountsPerRead argument, either100(default) or5. Five is accepted only with the explicit four-read stock profile. Serial/group callers cannot accidentally select it; every current production call site still uses the existing default.

The stock profile partitions program headers, linked deployment headers, code slices and final repeated metadata into actual requests of at most five accounts. Every chunk passes the original read implementation with its own requested floor, response context, exact mapping and read-budget increment. Slot observations are retained individually in the existing collection span; they are not collapsed into a synthetic bank snapshot. Following chunks use the latest observed floor.

Code identity collection has always described multiple observations across a full scan, not an atomic snapshot. It still hashes all code bytes and repeats every program/deployment header before publishing. Both full collections around simulation remain required. The300-read budget,32-slot bound,1MiB aggregate raw-code scheduling bound,720KiB slice limit, code-size caps, network checks, owner/link/authority checks and cancellation are unchanged. No cache, retry, metadata omission or program-ID allowlisting is introduced.

The default100 case sends the same account scope in one chunk. The original `accounts` body is identical to the extracted `accountChunk` body under a TypeScript printer comparison against0208e5a. Default-versus-explicit100 serial trace tests compare all requested methods, parameters, identities and read counts.

## Tests and remaining integration

New tests collect six upgradeable programs, compare complete hashes, code lengths, authorities and total bytes against the existing profile, and assert every actual ordinary metadata/body/recheck request has at most five accounts. A mocked-HTTP composition with the real bounded transport verifies its wire cap too. Tests refuse serial-group selection, stale response,33-slot response, incomplete mapping, changed repeated authority,429 and cancellation before another chunk. Advancing-slot tests verify subsequent floors and the final maximum slot.

Final Node24.19.0 verification:13 files/310 tests together, followed by four distinct mixed-packing/group-runtime files/22 tests, all passing. Total17 files/332 tests. Plain TypeScript and two-file typed lint pass. The broader set includes group runtime probing, exact authorization and owned runtime service checks, plus existing stock wallet, preflight, order, runtime and ordering tests. No full-suite, production build, browser, live RPC or latency result is claimed.

The transport and collector must both explicitly receive the five-account cap when a runtime path opts in. No production service, script, provider setting, credential, migration, cron, UI file, signing authority or deployment changed. Runtime inventories and other account readers still need explicit per-response slot/provenance handling; the offline partitioned wallet path is not selected by production. A new live SOL/USDC qualification campaign has not run.
