# HEARTBEAT.md -- OpenCode Engineer Checklist

Execute this checklist immediately and autonomously on every heartbeat. Do not ask what to do. Work on exactly one assigned issue, always through the orchestration helper described below. See [AGENTS.md](./AGENTS.md) for full boundaries.

## 1. Identify and verify task

- Read `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, and `PAPERCLIP_RUN_ID`.
- If `PAPERCLIP_TASK_ID` is present, inspect that issue first. Otherwise query only issues assigned to you in `in_progress`, `todo`, or `blocked` with new actionable context.
- Hard stop if no single assigned issue is actionable, the issue is assigned to someone else, or its status is `done`, `cancelled`, or `in_review`.
- For `blocked`, read comments first. Continue only if the latest relevant feedback is QA/human rework for OpenCode Engineer.
- Read the issue description, acceptance criteria, and all relevant comments.

## 2. Mandatory isolated git worktree

Never edit the repository root checkout. It is preparation-only and must remain clean on `develop`; do not create branches there and do not run `git checkout` there. Use the issue-specific worktree path (see [TOOLS.md](./TOOLS.md)).

## 3. Drive the bounded orchestration helper (mandatory, no bypass)

Do not write a Prometheus or Atlas prompt by hand and do not implement code directly. Invoke the pilot's orchestration helper for this task with the task's exact worktree, model, and Paperclip env. The helper:

1. Launches exact-name `Prometheus - Plan Builder` to produce a plan and machine-readable policy sidecar.
2. Validates the plan and sidecar with the deterministic plan-policy validator. An unvalidated or policy-rejected plan is a fail-closed hard stop: go to step 5, never implement freehand.
3. Sends one scoped approval on the same Prometheus session once the plan validates.
4. Launches exact-name `Atlas - Plan Executor` with the approved plan in the same task worktree.
5. On Atlas failure, resumes plan execution once in the parent `Sisyphus - ultraworker` session as a bounded fallback, never a second re-plan of valid work.
6. Persists stage/attempt/session state atomically after every transition (see step 6, state-resume).

If the helper's state reaches `failed_closed`, stop and follow step 5 below. Do not retry manually, do not fall back to freehand prompting, and do not call `opencode run` against Prometheus or Atlas outside the helper to route around any of these gates. There is no bypass of the orchestration helper.

## 4. Implement (only inside the helper's Atlas/fallback stage)

- Read `AGENTS.md` and `CLAUDE.md` in every repository you touch.
- Keep scope to the issue. Production, deploy, billing, secrets, and destructive data changes require explicit human approval.
- Add or update focused tests and run proportionate verification when work can proceed.
- Keep the diff surgical; do not refactor adjacent code.

## 5. Blocked / fail-closed protocol

If the helper fails closed, the plan is rejected, the agent-name/model preflight fails, or you cannot continue after a reasonable technical attempt, move the issue to `blocked`. Leave a concise Spanish comment stating:

- what was investigated and attempted, including the helper's stage and attempt number;
- the exact blocker and its evidence (state stage, redacted error);
- the repository, worktree, branch, and current code state;
- the concrete decision or external action that would unblock progress, naming the CEO/board as owner when a decision is required.

Do not change `assigneeAgentId`, create a subtask, or request automatic reassignment.

## 6. State-resume behavior

The helper's state file is authoritative across heartbeats, crashes, and cancellations. On every invocation it loads existing state for the task before doing anything else and resumes from the persisted stage: it never re-runs a completed stage and never re-plans an already-validated plan. Never hand-edit or delete the state file to skip a stage or reset the attempt counter.

## 7. Attempt-exhaustion disposition

The helper allows exactly one productive attempt plus two continuations. Once attempt 3 is exhausted (deadline, policy failure, or unresolved fallback), the helper writes an `exhausted_or_blocked` state and performs no further child work. On seeing that state:

- Do not invoke the helper again for a fourth attempt.
- Move the issue to `blocked` with the disposition above. This is a visible stop, never a silent loop and never a fabricated `complete`.

## 8. Handoff

- Commit and push from the worktree only.
- Create or update a PR against `develop`.
- Move the issue to `in_review`, never `done`, and do not provide your own `assigneeAgentId` in the transition.
- Leave a concise Spanish comment with summary, files changed, verification, branch/PR, and risks.
