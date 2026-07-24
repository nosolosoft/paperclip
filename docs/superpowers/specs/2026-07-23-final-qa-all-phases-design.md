# Final QA All-Phases Design

## Goal

Make one configured final QA agent perform the former Code, Browser, and Spec reviews in one pass, while preserving staged QA behavior for projects that still use it.

## Current Failure

Final QA currently uses one generic review stage, but a final QA update can close an issue with `status=done` without submitting `qaVerdict=pass` or `qaEvidence`. The agent instructions mention Code, Browser, and Spec, but the server does not enforce or durably validate all three phases.

## Contract

`qaEvidence` is a `QaReviewEvidenceV1` payload containing:

- Code checks and evidence.
- Browser `pass` evidence, or `not_applicable` with an empty evidence list.
- Every Spec acceptance criterion and its evidence.
- The project, reviewer agent, and PR/work-product handoff.

Final QA may close an issue only when the authenticated final QA participant submits `qaVerdict=pass` with valid evidence. A comment or execution-stage approval alone is insufficient.

Final QA failure sets `qaVerdict=fail`, returns the issue to the original Engineer, and causes the next final handoff to require a fresh full Code/Browser/Spec review.

## Scope

- Enforce the contract in HTTP issue updates and plugin-host issue updates.
- Persist evidence with the execution decision and expose it through issue state.
- Update final QA instructions to require all phases and structured evidence.
- Add focused tests for PASS, FAIL, invalid/incomplete evidence, re-handoff, persistence, and staged/final coexistence.
- Do not change Hermes, cron jobs, legacy agents, or staged routing semantics.

## Verification

- Existing staged QA tests remain green.
- Final QA cannot close with missing verdict/evidence.
- Final QA can close with complete Code + Browser/N-A + Spec evidence.
- QA FAIL returns to Engineer and a subsequent handoff selects the same configured final QA agent.
