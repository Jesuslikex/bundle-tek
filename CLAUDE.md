# Claude Code project notes

This folder is the Bundle application repository. Start with `PRODUCT-PARITY.md` and `PROXIMA-REVIEW.md` for the current product context, and read `HOLDER-RPC-SETUP.md` when working on holder reads.

## Preserve the working tree

Before changing files, inspect `git status --short`. This checkout contains a large amount of intentional uncommitted and untracked work. Preserve it. Do not reset, clean, stash, or restore broad file sets, and keep edits focused on the requested task.

## Git on this machine

Git is available through the local Codex runtime even when the Claude desktop terminal does not have it on PATH. In PowerShell, run:

```powershell
& 'C:\Users\Julian\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe' -C 'C:\Users\Julian\Desktop\Bundle' status --short
```

This executable was verified as Git 2.53.0.windows.3. Do not infer that Git is missing from `where git`: PowerShell aliases `where` to `Where-Object`. Use `Get-Command git` or `where.exe git` when checking PATH. Use the verified absolute executable above for this project; no Git installation is needed.

## Project and evidence context

The Proxima reference is a static browser client capture at `C:\Users\Julian\Desktop\REA\targets\proxima-20261009`, captured on 2026-10-09. Treat it as client-side evidence only, not current server behavior. For further Proxima reverse engineering, first read `C:\Users\Julian\.agents\skills\reverse-engineer-anything\SKILL.md` and follow its evidence and coverage requirements. The latest read-only review is `C:\Users\Julian\Documents\Codex\2026-10-09\https-github-com-morluto-rea-https\claude-opus-5-5-rea-review.jsonl`.

## Wallet and transaction boundaries

Wallet private keys belong encrypted in the browser with user-controlled export. A user must explicitly review and approve each transaction before signing. Do not automate signing or send transactions. Do not read or print `.env*` files, keys, clipboard contents, or other credentials. Do not create paid services, change provider credentials, or deploy unless the user explicitly asks for that action.

## Review discipline

Keep claims tied to the code or captured evidence you inspected. State when provider data is sampled or incomplete. Before any code change, summarize the files and behavior you plan to change; for financial actions, credential changes, or deployment, wait for explicit user authorization.

