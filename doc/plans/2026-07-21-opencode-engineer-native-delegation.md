# T11: OpenCode Engineer — Native Sisyphus Delegation Design

Status: approved design, not yet implemented. Owner: OpenCode Engineer pilot (`recover-opencode-engineer-pilot`). This document specifies the replacement for the mandatory Prometheus->Atlas->Sisyphus orchestration helper described in the current `scripts/agent-pilots/opencode-engineer/bundle/{AGENTS,HEARTBEAT,TOOLS}.md`. No instruction file, adapter code, or live agent config is changed by this document. It is the decision record a follow-up implementation task will execute against.

## 1. Why this replaces the helper

The T9 real-run proof (`decisions.md`, `native-sisyphus-delegation-proof`) showed that `Sisyphus - ultraworker` can drive planning, review, and implementation directly through OpenCode's native `task()` tool, without any external orchestration process. It also proved the opposite is not possible as designed: `task()` cannot target `Prometheus - Plan Builder` or `Atlas - Plan Executor` because both are registered as OpenCode `primary` agents, and `task()` only dispatches to `subagent`/`all`-mode agents (`plan`, `momus`, `general`, `Sisyphus-Junior` are available today). The external helper (`orchestrator.ts` and friends) exists only to work around that mismatch by shelling out to `opencode run --agent "Prometheus - Plan Builder"` as a separate process. That workaround adds a whole bounded child-process/state-file layer to reach a delegation OpenCode already supports natively for `plan`/`momus`/`general`. User has approved option 1: drop the external helper requirement and mandate native `task()` delegation instead.

## 2. Mandatory workflow (replaces HEARTBEAT.md step 3)

Every assigned issue MUST go through exactly this sequence once checked out into its isolated worktree:

1. **Plan.** Call `task(subagent_type="plan")` with the issue's acceptance criteria, repo `AGENTS.md`/`CLAUDE.md` context, and worktree path. This produces a structured, issue-scoped plan (files, acceptance-criteria mapping, test plan, risks) plus the OpenCode session id for that call.
2. **Persist.** Sisyphus writes the plan session's rendered plan document under the task worktree's canonical `.omo/plans/` directory and records the plan session id in the issue's tracked state (Section 4). Momus accepts `.omo/plans/*.md` paths. This is a plain file write by Sisyphus, not a second agent call.
3. **Review.** Call `task(subagent_type="momus")` ("Momus - Plan Critic") against the persisted plan, asking for an adversarial pass/reject verdict with concrete findings.
4. **One bounded revision.** If Momus rejects: Sisyphus revises the persisted plan directly using Momus's findings and overwrites the same plan file. It does not resume the `plan` session or start a replacement planning session. Call `task(subagent_type="momus")` **once more** against the revision. If Momus rejects again, this is a hard stop — go to Section 5 (fail-closed). There is no second revision loop and no third Momus call for this issue attempt.
5. **Implement.** Once Momus approves (first or second pass), call `task(subagent_type="general")` with the approved plan and the worktree path, instructing it to implement exactly that plan, add/update tests per the plan's acceptance-criteria mapping, and report files touched.
6. **Independent verification.** Sisyphus itself (not a subagent call) verifies the `general` session's result: reads the actual diff (`git status`/`git diff` in the worktree), confirms it matches the plan's declared file list and scope, runs the tests/commands the plan specified, and checks each acceptance criterion against real output. This step must not simply trust the `general` session's self-report.
7. **One bounded remediation.** If verification fails: resume the **same** `general` session with the specific verification failures and ask for a fix. Verify again per step 6. If verification still fails, this is a hard stop — go to Section 5. There is no second remediation loop.

Steps 1-7 run at most once per issue per heartbeat attempt. A later heartbeat (new wake, e.g. after QA sends the issue back) starts a fresh pass at step 1, using the current plan/session ids only as prior context if still present (Section 4), not as a mandatory resume point.

## 3. Fail-closed rules

- A rejected plan after the single bounded revision (step 4) is a hard stop: do not implement anything, do not call `general`. Move the issue to `blocked` with a concise Spanish comment naming both Momus verdicts and the outstanding findings.
- A failed verification after the single bounded remediation (step 7) is a hard stop: do not open or update a PR from unverified work. Move the issue to `blocked` with a concise Spanish comment naming what verification failed (specific test, specific acceptance criterion, or scope mismatch) and the current diff state.
- Any `task()` call that errors, times out, or returns no usable session id is treated the same as a rejection/failure at that step — no silent retry beyond the one bounded revision/remediation already defined above.
- A `general` session whose diff touches files outside the plan's declared file list is a scope violation, not a verification pass, even if tests are green; treat it as a failed verification (step 6) and follow the same single-remediation-then-stop rule.
- None of these fail-closed paths change `assigneeAgentId`, open a subtask, or request reassignment — same as the current helper's disposition.

## 4. State continuity (no new helper state file)

The external helper's `<instance-root>/data/pilots/opencode-engineer/<task-id>/state.json` is retired for this workflow. Continuity across heartbeats uses only mechanisms OpenCode and Paperclip already provide:

- **OpenCode task session ids.** The `plan`, `momus`, and `general` session ids returned by each `task()` call remain audit evidence; only the `general` session is a resume handle for step 7. Step 4 is a direct Sisyphus edit because current `plan` continuation calls complete without assistant text. Sisyphus keeps ids only as plain text in issue-scoped working notes, not as a structured/authoritative state machine.
- **Paperclip heartbeat continuation.** Attempt/turn continuation across wakes is handled by Paperclip's own `maxTurnContinuation` heartbeat mechanism (already configured on the live agent) and by the issue's `status`/comment history, which already carries "what was tried" context for the next heartbeat to read (per `HEARTBEAT.md` step 1).
- No file replaces the old `state.json`. If a heartbeat is interrupted mid-workflow, the next heartbeat re-reads the issue's comments/worktree git state, determines which of steps 1-7 last completed from that evidence, and continues from there — it does not need a dedicated machine-readable state schema to do so.

## 5. Prometheus/Atlas: removed from mandatory path, not deleted

- `AGENTS.md`/`HEARTBEAT.md`/`TOOLS.md` will stop mandating the external helper and stop referencing `Prometheus - Plan Builder` / `Atlas - Plan Executor` by name as required stages. That instruction rewrite is the follow-up implementation task, not this document.
- The helper's source (`orchestrator.ts`, `orchestrator-runner.ts`, `orchestrator-state.ts`, `orchestrator-types.ts`, `orchestrator-cli.ts`, `agent-selection.ts`, `plan-policy-validator.ts`, and their tests) stays in the repo untouched. It is historical/reference code for a helper this pilot no longer runs by default, not dead code to delete in this pass.
- Nothing in this design mutates live Paperclip agent config, the adapter runtime (`packages/adapters/opencode-local`), or the four `Prometheus - Plan Builder`/`Atlas - Plan Executor` primary-agent registrations themselves. Those remain exactly as configured.

## 6. Preserved invariants (unchanged from current bundle)

- Exactly one assigned Paperclip issue per attempt; no unassigned work.
- All work happens inside the issue's isolated git worktree; the repo root checkout is never edited or branched.
- All issue comments and the final handoff comment are written in Spanish.
- Completion opens/updates a PR against `develop`, never `master`/`main`.
- On success the issue moves to `in_review` for QA, never `done`, and without setting `assigneeAgentId`.
- Merging PRs, deploying, restarting production, mutating production data, or expanding scope beyond the issue's acceptance criteria still requires explicit human/board approval and is out of the autopilot boundary.
- The exact three installed skills (`design-critique`, `github-pr-workflow`, `issue-triage`) are unchanged.

## 7. Test plan for the follow-up implementation task

1. **Bundle lint.** Extend `bundle-linter.ts`'s `REQUIRED_BUNDLE_PHRASES` check for the new mandatory-workflow language (e.g. "native delegation", "fail-closed", "bounded revision", "bounded remediation") and drop the phrases that only made sense for the external helper ("orchestration helper", "no bypass", "state-resume", "attempt-exhaustion") once the new instructions no longer use them. Existing forbidden-field/secret checks are unaffected.
2. **Source/live hash parity.** After re-uploading the rewritten `AGENTS.md`/`HEARTBEAT.md`/`TOOLS.md` to the live pilot agent, fetch them back and confirm SHA-256 parity with the source bundle files, the same check T8 already performs.
3. **Real isolated smoke.** Re-run a disposable-worktree smoke equivalent to T9, but driving the workflow in Section 2 directly through `task()` calls instead of the external helper: one small real issue through plan -> persist -> momus approve -> general -> verify -> PR-ready state, captured with real session ids and a real diff.
4. **Session-parent evidence.** Confirm, from OpenCode's own session storage/logs, that the `plan`, `momus`, and `general` sessions from the smoke run are recorded as child sessions of the Sisyphus run that invoked them — replacing the old Prometheus/Atlas/Sisyphus session evidence T9 collected, with the same evidentiary bar.
5. **Negative missing-review test.** Prove the fail-closed path: force a `momus` rejection twice in a row (initial + the one bounded revision) on a disposable issue and confirm the workflow stops before any `general` call, leaves the issue `blocked` with a Spanish comment naming both verdicts, and does not fabricate progress.

## 8. Out of scope for this document

- Rewriting `AGENTS.md`/`HEARTBEAT.md`/`TOOLS.md` text.
- Touching `bundle-linter.ts`, the adapter runtime, or any live agent config/instructions upload.
- Deleting or refactoring the existing Prometheus/Atlas helper source.
- Adding any new dependency.

## 9. Decision-completeness check

Every workflow branch in Section 2 has exactly one explicit next step (continue, one bounded retry, or fail-closed per Section 3); no step is left open-ended, and no open design question remains for the follow-up implementation task to resolve on its own judgment.
