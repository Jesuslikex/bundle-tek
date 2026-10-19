# Saved layer plan review visibility

Before editing, 19 October 2026: Codex claims `components/launch/pump-layer-planner.tsx` and its existing test. These are Codex-owned launch-layer paths. Claude Opus 5.5's restricted, read-only review identified that saving a valid planning snapshot leaves the saved review and coverage collapsed. Source inspection confirms it; opening an existing history entry already reveals that panel.

After a validated, current save response, reveal and focus the saved review. Preserve the exact response binding, cancellation guards, history-opening behavior, consent and funding/signing gates. Test against the existing authenticated route/service/SQL composition. No protected Claude components, deployment, hosted SQL or funded wallet actions.

Follow-up notice after `c2a585d`: the same owned planner/test will preserve its Front-only refusal of a non-StonkFun saved context but show the specific static StonkFun prerequisite. It must not expose arbitrary parser/server exception text or admit the mismatched context. Separate commit and regression check.
